---
veye: true
title: berth architecture
type: architecture
covers:
  - packages/berth/src/cli.ts
  - packages/berth/src/scaffold.ts
  - packages/berth/src/guard/build-env.ts
  - packages/berth/src/constants.ts
  - packages/berth/scripts/require-worktree.sh
depends_on:
  - docs/wiki/threat-model.md
  - docs/wiki/adapter-author-guide.md
  - docs/wiki/development.md
last_verified: 2026-07-13
---

## What berth is

**berth** is a toolkit that turns a pile of cooperating AI coding agents into a
disciplined, parallel-safe, review-gated development workflow. It does **not**
run models or agent loops — those belong to Agent Runtimes (Claude Code,
OpenCode, Pi). berth owns the spine around them: a trunk guard, an
orchestration topology, a review-gated merge loop, an issue/triage workflow, and
a local-gates stack.

The goal is simple: make a swarm of autonomous agents safe to point at the same
repository by guaranteeing that no agent ever mutates the protected trunk
directly, that work happens on isolated linked worktrees, and that nothing
lands until a review says so.

## The four modules

berth is built as four modules, each addressing a distinct concern. They are
designed to compose; each is independently useful.

| Module           | Concern                                                                  | Lives in                            |
| ---------------- | ------------------------------------------------------------------------ | ----------------------------------- |
| **Trunk Guard**  | No agent mutates the primary checkout directly                           | shell script + per-runtime adapters |
| **Orchestrator** | Topology: one master, many layer-1 agents, a few layer-2 helpers         | orchestration scripts               |
| **Init**         | Wire guard + adapters into a target repo atomically                      | scaffold.ts                         |
| **Router**       | The `berth` CLI itself — `parseArgs` over `init` + orchestration scripts | cli.ts                              |

The Trunk Guard is the keystone — every other module depends on it. The
Orchestrator is the next layer — it composes the guard with `herdr` (terminal
multiplexer) and `wt` (worktree manager) to produce a swarm topology.

## Decision order in the trunk guard

Given the command the caller is about to run, the guard applies this decision
order (first match wins):

| #   | Condition                                    | Outcome   |
| --- | -------------------------------------------- | --------- |
| 1   | `BERTH_ALLOW_MAIN_WORKTREE=1` is set         | allow     |
| 2   | `BERTH_MASTER_SESSION=1` is set              | allow     |
| 3   | `$1` matches the bootstrap whitelist         | allow     |
| 4   | not inside a git repository                  | allow     |
| 5   | `.git` is a **file** (linked worktree)       | allow     |
| 6   | `.git` is a **directory** (primary checkout) | **block** |

Exit codes: `0` = allow, `2` = block. Unexpected failure is **fail-closed**
(block). The decision order matters: explicit override hatches come first so
operator intent is honored, the bootstrap whitelist comes second so an agent
stranded in the primary can still _leave_, and the worktree check is the final
default-deny.

## Naming and the single-source-of-truth principle

Every env var, command verb, and user-facing string is derived from the
constants in `packages/berth/src/constants.ts`. The shell guard at
`packages/berth/scripts/require-worktree.sh` mirrors these env-var names by hand because it
runs before any TypeScript is compiled or imported. Rename the tool by editing
one file — and updating the shell mirror.

The constants:

```typescript
TOOL_NAME = "berth";
ENV_PREFIX = "BERTH_";
WORKTREE_MANAGER_CMD = "wt";
ALLOW_MAIN_WORKTREE = "BERTH_ALLOW_MAIN_WORKTREE";
MASTER_SESSION = "BERTH_MASTER_SESSION";
```

## The init scaffolder — plan-then-execute

`berth init` is **atomic** (plans every write, writes nothing until every
precondition passes), **idempotent** (a second run with the guard + requested
adapters already in place is a clean no-op), and **fail-closed** (refuses
non-git targets and unforced overwrites). See `packages/berth/src/scaffold.ts` for the
canonical implementation.

The plan-then-execute ordering is critical. The scaffolder:

1. Resolves the target (must exist, must be a directory).
2. Asserts the target is a git repo (otherwise the guard is meaningless).
3. Verifies every source template exists.
4. Builds the full copy plan: guard + every requested adapter + orchestrator
   scripts + master agent defs (when `--with-orchestrator`).
5. If every destination already exists and `--force` is unset, returns
   `alreadyInstalled: true` and writes nothing.
6. If some destinations exist and `--force` is unset, throws `InitError` with
   exit 1.
7. Executes the plan: `mkdir -p` each directory, copy each file, `chmod 0755`
   the guard and orchestrator scripts, merge the Claude Code
   `settings.json` (preserving every existing key), merge the orchestrator
   pnpm scripts into `package.json` (preserving every existing script).

The Claude Code settings.json merge is a useful pattern in its own right:
berth drops any prior berth hook entry (matched by command) and adds one
canonical entry, so the result is exactly one berth hook no matter how many
times you run `init`. Existing keys, hooks, and unrelated PreToolUse entries
are preserved verbatim.

## The orchestrator topology

berth composes `herdr` (tabs + panes) with `wt` (linked worktrees) to produce
the swarm topology:

```
Workspace  (one herdr workspace — the whole session)
│
├─ Tab 1 — MASTER (layer 0)      orchestrator; runs in the primary with the hatch
│
├─ Tab 2 — layer-1 agent A       ← own worktree (branch a)
│    ├─ pane A.0  (the layer-1 agent)
│    └─ pane A.1  (layer-2 subagent)   ← shares worktree a
│
└─ Tab 3 — layer-1 agent B       ← own worktree (branch b)
     └─ pane B.0  (the layer-1 agent)
```

A new tab ⟺ a new worktree (layer-1 spawn creates both). A pane split shares
its parent's worktree (layer-2 spawn creates neither). Max depth is 2.

The master is the **only** session that carries the trunk-orchestration hatch.
Both spawn scripts explicitly `unset BERTH_ALLOW_MAIN_WORKTREE
BERTH_MASTER_SESSION` before launching the runtime, so a dispatched subagent
can never satisfy the hatch by inheritance — even if it `cd`s into the primary
checkout.

## Adapter contracts — extract and delegate, never decide

Adapters are runtime-specific shims that feed the canonical trunk guard. Each
adapter extracts the command string the caller is about to run (empty for
edit and write tools), resolves the guard script, shells out to it, and
**fails closed** (blocks) on exit 2 or any unexpected error. Adapters never
reimplement the decision — they extract and delegate.

| Adapter                     | Runtime                        |
| --------------------------- | ------------------------------ |
| Claude Code PreToolUse hook | Node ESM (reads JSON on stdin) |
| OpenCode plugin (reference) | OpenCode plugin                |
| Pi extension                | Pi extension                   |

The **OpenCode** adapter is the **agent-aware reference**: it tracks the
active agent per session and builds the guard env via `buildGuardEnv` (an
inlined copy of `packages/berth/src/guard/build-env.ts`). A master session asserts
`BERTH_MASTER_SESSION=1`; a non-master session has both master hatches
scrubbed, so it can never satisfy them by inheritance.

The **Claude Code** and **Pi** adapters forward `process.env` unchanged — the
operator or launcher controls the master hatches.

## The master's no-edit rule

The master agent **orchestrates: plans, dispatches, verifies — it never edits
files.** Each runtime enforces the no-edit rule with its own mechanism:
OpenCode denies edit and write permissions, Claude Code uses a tools
allow-list that omits Write / Edit / MultiEdit, Pi is prompt-only with the
guard as backstop.

The trunk guard is the defense in depth that catches anything the runtime
permissions let through.

## Why a shell script is the source of truth

The guard decision lives in a shell script, not in TypeScript. Reasons:

- It runs **before** any TypeScript is compiled or imported. Adapters shell
  out to it; it does not import anything.
- It works on any POSIX shell, on any host with `git` and `bash` available.
  No node, no pnpm, no `packages/berth/dist/` build artifact to keep in sync.
- It is the single canonical decision point. All three adapters consult it.
  Adding a new runtime means writing a new adapter that calls this script —
  not reimplementing the rule.

The TypeScript side (build-env.ts and the OpenCode adapter's inlined copy)
handles **what env to pass the guard with**, not what the guard decides.
The shell script decides.

## Related

- [Threat model](threat-model.md) — what the guard protects against
- [Adapter author guide](adapter-author-guide.md) — how to write a new runtime adapter
- [Glossary](glossary.md) — terminology
