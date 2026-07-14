---
veye: true
title: berth glossary
type: concept
covers:
  - packages/berth/src/constants.ts
  - packages/berth/src/cli.ts
last_verified: 2026-07-13
---

---

## Adapter

A runtime-specific shim that feeds the canonical trunk guard. Examples:
Claude Code PreToolUse hook, OpenCode plugin, Pi extension. Adapters
**extract and delegate** — they never reimplement the decision.

See [adapter-author-guide.md](adapter-author-guide.md).

## Bootstrap whitelist

A read-only subset of worktree-manager verbs that the guard allows from the
primary checkout. Lets an agent stranded in the primary **leave** it for a
linked worktree. The `merge` and `remove` verbs are deliberately excluded.
Arguments are restricted to a strict alphabet so shell metacharacters cannot
be smuggled in.

## Branch

A git branch name. Layer-1 agents are spawned with their own branch and
worktree.

## Change

A piece of work tracked from `berth feat <branch>` (open) to `berth ship`
(close). Conceptually a PR. A Change has one branch and one worktree.

## Decision order

The fixed sequence in which the guard evaluates whether to allow or block a
command. See
[architecture.md](architecture.md#decision-order-in-the-trunk-guard).

## Editor / Writer caller

A tool invocation that mutates a file rather than executing a command. These
pass an empty command string to the guard, which never matches the bootstrap
whitelist and falls through to the worktree check.

## Fail-closed

The property that any unexpected error in the guard chain (missing script,
spawn error, unexpected exit code, etc.) **blocks** rather than allows.
This is the default behavior. Silent fall-through would defeat the guard's
guarantee.

## Hatch

An env variable that opens an explicit exception to the primary-checkout
block. There are two:

- The allow-main-worktree hatch — operator override. Set by the master
  launcher.
- The master-session hatch — coordinator session marker. Set by the OpenCode
  adapter's `buildGuardEnv(isMaster=true)`.

A non-master session has both hatches scrubbed from its environment, so it
cannot satisfy either hatch by inheritance.

## herdr

A terminal multiplexer for coding agents (a third-party tool, not part of
berth). berth composes with herdr's tabs and panes to build the
orchestration topology. Requires `HERDR_WORKSPACE_ID` to be set.

## Init

The `berth init` subcommand. Wires the trunk guard + requested runtime
adapters (+ optionally the orchestrator) into a target repo. **Atomic**,
**idempotent**, **fail-closed**.

## Layer

The depth of an agent in the orchestration topology.

- **Layer 0** — the master. Runs in the primary checkout. Carries the master
  hatch. Spawns layer-1 agents.
- **Layer 1** — an agent in its own tab + linked worktree. Spawned via
  `berth layer1`. May spawn layer-2 panes.
- **Layer 2** — an agent in a pane split inside a layer-1's tab, sharing
  the layer-1's worktree. Spawned via `berth layer2`. **Cannot spawn
  further** (max depth 2).

The layer is communicated to agents via the agent-layer env var set to 0, 1,
or 2.

## Linked worktree

A git worktree created via `git worktree add` (or `wt switch -c`). Lives at
a separate path; shares `.git` history with the primary checkout; has `.git`
as a **file** (a gitdir pointer) rather than a directory. The guard allows
mutations here.

## Master

The single layer-0 orchestrator session. Runs in the primary checkout.
Carries the trunk-orchestration hatch. **Orchestrates only**: plans,
dispatches, verifies. **Never edits files** — enforced by runtime
permissions per agent runtime.

## Orchestrator

The set of `berth master`, `berth layer1`, `berth layer2`, `berth feat`,
`berth ship` subcommands and their backing scripts. The orchestration
topology that makes a swarm of agents safe to point at one repo.

## Primary checkout

The original git working tree, where `.git` is a **directory**. The
**protected trunk**. The guard blocks all mutations here unless a hatch is
set.

## Runtime

The agent platform berth is wiring an adapter for. One of the supported
runtimes (Claude Code, OpenCode, Pi, or your own).

## Trunk

The protected primary checkout. Synonym for "primary checkout" in berth
contexts.

## Trunk guard

The single shell script that decides whether a command may run. The
keystone of berth. Source of truth for the block-or-allow decision.

## Worktree

A git worktree. Can be the primary checkout (`.git` is a directory) or a
linked worktree (`.git` is a file). The guard treats the two differently.

## `wt`

The worktree manager. Not part of berth — berth requires you to have one.
`wt switch -c <branch>` is the canonical way to enter a linked worktree.

## Related

- [Architecture](architecture.md)
- [Threat model](threat-model.md)
- [Adapter author guide](adapter-author-guide.md)
