# berth

> **Status:** early / experimental, pre-release. Everything here is subject to
> change. Do not depend on it yet.

**berth** is a toolkit that turns a pile of cooperating AI coding agents into a
disciplined, parallel-safe, review-gated development workflow. It does **not**
run models or agent loops — those belong to Agent Runtimes (Claude Code,
OpenCode, Pi, and friends). berth owns the spine around them: a trunk guard, an
orchestration topology, a review-gated merge loop, an issue/triage workflow, and
a local-gates stack.

The goal is simple: make a swarm of autonomous agents safe to point at the same
repository by guaranteeing that no agent ever mutates the protected trunk
directly, that work happens on isolated linked worktrees, and that nothing lands
until a review says so.

## Trunk Guard (Module 1)

The Trunk Guard is berth's keystone. It is a single shell script —
[`scripts/require-worktree.sh`](./scripts/require-worktree.sh) — that decides
whether a command may run. Wire it as a pre-tool-use / pre-edit hook in your
Agent Runtime and every mutation the agent attempts is gated by it.

### How it decides

Given the command the caller is about to run as `$1`, the guard applies this
decision order (first match wins):

| #   | Condition                                    | Outcome   |
| --- | -------------------------------------------- | --------- |
| 1   | `BERTH_ALLOW_MAIN_WORKTREE=1` is set         | allow     |
| 2   | `BERTH_MASTER_SESSION=1` is set              | allow     |
| 3   | `$1` matches the bootstrap whitelist         | allow     |
| 4   | not inside a git repository                  | allow     |
| 5   | `.git` is a **file** (linked worktree)       | allow     |
| 6   | `.git` is a **directory** (primary checkout) | **block** |

Exit codes: `0` = allow, `2` = block. Unexpected failure is **fail-closed**
(block).

### The bootstrap whitelist

So that an agent stranded in the primary checkout can still _leave_ it, a small
read-only subset of the worktree-manager verbs (`wt ...`) is allowed through:

```
^wt (switch|list|path|which|config|diff|log|step)( [a-zA-Z0-9._=/@:+-]+){0,16}$
```

- Only those subverbs — `merge` and `remove` are deliberately **excluded**.
- Arguments are restricted to a strict alphabet, so shell metacharacters
  (`;`, `&&`, `|`, backticks, `$()`, redirections) cannot be smuggled in.
  `wt switch foo; rm -rf /` is rejected.
- Editors and writers pass `""` (empty) as the command, which never matches the
  whitelist and falls straight through to the worktree check.

### Usage

```sh
# allow: running inside a linked worktree
./scripts/require-worktree.sh "rm -rf build"

# allow: operator override
BERTH_ALLOW_MAIN_WORKTREE=1 ./scripts/require-worktree.sh "rm -rf build"

# block: a mutating command in the primary checkout
./scripts/require-worktree.sh "rm -rf build"   # exit 2

# allow: read-only worktree-manager verb, even in the primary
./scripts/require-worktree.sh "wt switch -c feat/x"
```

The companion TypeScript helper
[`src/guard/build-env.ts`](./src/guard/build-env.ts) (`buildGuardEnv`) builds the
environment a guarded child process should run with: a master session inherits
the parent env **and** asserts `BERTH_MASTER_SESSION=1`; a non-master session
inherits the parent env **but** has both master hatches scrubbed, so it can never
satisfy either hatch by inheritance alone. All naming lives in
[`src/constants.ts`](./src/constants.ts) — rename the tool by editing one file.

## Adapters

Runtime-specific shims that feed the canonical trunk guard. Each adapter
extracts the command string the caller is about to run (`""` for edit/write
tools), resolves the guard script, shells out to it, and **fails closed**
(blocks) on exit 2 or any unexpected error. Adapters never reimplement the
decision — they extract and delegate.

| Adapter                     | File                                                                           | Runtime                        |
| --------------------------- | ------------------------------------------------------------------------------ | ------------------------------ |
| Claude Code PreToolUse hook | [`adapters/claude/worktree-guard.mjs`](./adapters/claude/worktree-guard.mjs)   | Node ESM (reads JSON on stdin) |
| OpenCode plugin (reference) | [`adapters/opencode/worktree-guard.ts`](./adapters/opencode/worktree-guard.ts) | OpenCode plugin                |
| Pi extension                | [`adapters/pi/worktree-guard.ts`](./adapters/pi/worktree-guard.ts)             | Pi extension                   |

**Guard-path resolution** (shared by all three): if `BERTH_GATE_SCRIPT` is set
(absolute path) use it; otherwise resolve the repo root via
`git rev-parse --show-toplevel` and use `<root>/scripts/require-worktree.sh`.
If neither can be found, the adapter fails closed.

- The **OpenCode** adapter is the **agent-aware reference**: it tracks the
  active agent per session and builds the guard env via `buildGuardEnv` (an
  inlined copy of [`src/guard/build-env.ts`](./src/guard/build-env.ts)). A
  master session asserts `BERTH_MASTER_SESSION=1`; a non-master session has
  both master hatches scrubbed, so it can never satisfy them by inheritance.
- The **Claude Code** and **Pi** adapters forward `process.env` unchanged —
  the operator/launcher controls the master hatches.

Each adapter is a **self-contained deployable file**. `berth init` scaffolds
copies of these into a target repo's `.claude/hooks/`, `.opencode/plugins/`,
and `.pi/extensions/`.

## Installing the guard into a repo (`berth init`)

`berth init` wires the canonical guard + the requested runtime adapter(s) into a
target git repo so its primary checkout is protected from direct agent edits.
It is **atomic** (plans every write, writes nothing until every precondition
passes), **idempotent** (a second run is a clean no-op), and **fail-closed**
(refuses non-git targets and unforced overwrites).

### Install (from source)

berth is not yet published to npm — it is `"private"` and is meant to be run
from this repo for now.

```sh
git clone <this-repo> agentic-tools
cd agentic-tools
pnpm install
pnpm --filter berth build      # emits dist/cli.js (+ chmods it executable)
```

### Usage

```sh
# install the guard + all three runtime adapters into ./my-repo
node packages/berth/dist/cli.js init ./my-repo --runtime claude,opencode,pi

# only Claude Code (the default target is the current directory)
node packages/berth/dist/cli.js init --runtime claude

# overwrite an existing install
node packages/berth/dist/cli.js init ./my-repo --force
```

```
berth init [target] [--runtime <list>] [--force]
  target     repo path to install into (default: current directory)
  --runtime  comma-separated subset of: claude,opencode,pi  (default: all three)
  --force    overwrite an existing install
```

Exit codes: `0` success (or already installed), `1` precondition error (not a
git repo, conflict, bad args), `2` unexpected error.

### What `init` writes

| Runtime    | Files written into the target repo                                        |
| ---------- | ------------------------------------------------------------------------- |
| (always)   | `scripts/require-worktree.sh` (copied verbatim, mode `0755`)              |
| `claude`   | `.claude/hooks/worktree-guard.mjs` + a **merged** `.claude/settings.json` |
| `opencode` | `.opencode/plugins/worktree-guard.ts`                                     |
| `pi`       | `.pi/extensions/worktree-guard.ts`                                        |

The Claude Code `settings.json` merge adds a `PreToolUse` hook (matcher
`Write|Edit|MultiEdit|Bash`) pointing at the adapter, and **preserves** every
existing key and hook — it never clobbers. The resolved guard path is printed in
the install summary.

### Next steps after install

- **Claude Code:** restart your session so the `PreToolUse` hook loads.
- **OpenCode:** ensure `@opencode-ai/plugin` is available in the project.
- **Pi:** restart Pi to load the extension.

The guard then blocks edits in the primary checkout; move work into a linked
worktree first: `wt switch -c <branch>`.

### Uninstall

Remove the files listed above from the target repo and revert the
`.claude/settings.json` merge (delete the berth `PreToolUse` entry; any other
hooks/keys were preserved verbatim). For a clean record, `git checkout` /
`git clean` the created paths.

## Orchestrator (Module 2)

On top of the trunk guard, berth provides an orchestration topology: one
**master** (layer 0) session that runs in the primary checkout and dispatches
implementation work to **layer-1** subagents (new tab + new worktree) and
**layer-2** subagents (pane split, shared worktree). Max depth is 2.

```text
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

### The five commands

| Command                                  | Who calls it    | What it does                                                                                          |
| ---------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------- |
| `berth master [runtime]`                 | human           | launches the layer-0 master in the primary (exports `BERTH_ALLOW_MAIN_WORKTREE=1`, execs the runtime) |
| `berth layer1 <name> <branch> [runtime]` | master          | new tab + new worktree + launch a layer-1 subagent                                                    |
| `berth layer2 <name> [runtime]`          | a layer-1 agent | pane split in the current tab, shares the parent's worktree                                           |
| `berth feat <branch>`                    | human           | open a Change in a linked worktree (+ optional herdr workspace)                                       |
| `berth ship`                             | human           | close a Change: `wt merge main` (+ optional herdr close)                                              |

Runtime is `opencode` (default), `claude`, or `pi`.

### Layer identity env vars

Each spawn injects three env vars so the agent can self-identify:

| Var                    | Set to                             |
| ---------------------- | ---------------------------------- |
| `BERTH_AGENT_LAYER`    | `0` (master, implicit) · `1` · `2` |
| `BERTH_AGENT_BRANCH`   | the branch the worktree is on      |
| `BERTH_AGENT_WORKTREE` | absolute path to the worktree      |

### Defense in depth

The master is the **only** session that carries the trunk-orchestration hatch
(`BERTH_ALLOW_MAIN_WORKTREE=1`). Both spawn scripts (`spawn-layer1.sh`,
`spawn-layer2.sh`) `unset BERTH_ALLOW_MAIN_WORKTREE BERTH_MASTER_SESSION`
before launching the runtime, so a dispatched subagent can never satisfy the
hatch by inheritance — even if it `cd`s into the primary checkout.

### Dry-run inspection

`BERTH_MASTER_DRY_RUN=1 berth master [runtime]` prints the resolved runtime and
the hatch value without launching anything — useful for scripts and inspection.

### Installing the orchestrator (`berth init --with-orchestrator`)

```sh
# install the guard + adapters + the full orchestrator
node packages/berth/dist/cli.js init ./my-repo --with-orchestrator

# overwrite an existing orchestrator install
node packages/berth/dist/cli.js init ./my-repo --with-orchestrator --force
```

When `--with-orchestrator` is set, `berth init` additionally writes:

| What                     | Where                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| master agent definitions | `.claude/agents/master.md`, `.opencode/agent/master.md`, `.pi/prompts/master.md`                                              |
| orchestration scripts    | `scripts/master.sh`, `scripts/spawn-layer1.sh`, `scripts/spawn-layer2.sh`, `scripts/feat.sh`, `scripts/ship.sh` (mode `0755`) |
| pnpm convenience scripts | merged into the target's `package.json` (`master`, `layer1`, `layer2`, `feat`, `ship`)                                        |

The master agent **orchestrates: plans, dispatches (via `berth layer1` /
`berth layer2`), verifies — it never edits files.** Each runtime enforces the
no-edit rule with its own mechanism: OpenCode (`permission: { edit: deny,
write: deny }`), Claude Code (`tools:` allow-list omits Write / Edit /
MultiEdit), Pi (prompt-only, with the guard as backstop).

## Development

Requires Node.js ≥ 20 and pnpm.

```sh
pnpm install                 # install dependencies
pnpm run ci                  # lint && build && typecheck && test (the full local gate)
pnpm lint                    # eslint
pnpm build                   # TypeScript build to dist/
pnpm typecheck               # tsc --noEmit
pnpm test                    # vitest run
pnpm test:coverage           # vitest run --coverage
pnpm format                  # prettier --write .
```

### Git hooks (optional, recommended)

This repo ships a [`lefthook.yml`](./lefthook.yml) that runs `eslint --fix` +
`prettier` on staged files pre-commit and `typecheck` pre-push. To enable it:

```sh
pnpm exec lefthook install
```

> Note: the aggregate gate script is named `ci`, but bare `pnpm ci` is
> intercepted by pnpm's reserved (not-yet-implemented) `ci` subcommand on recent
> pnpm versions, so run it as `pnpm run ci`.

## License

MIT — see [LICENSE](./LICENSE). Copyright &copy; berth contributors.
