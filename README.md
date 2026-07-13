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
