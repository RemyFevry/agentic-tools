---
veye: true
title: berth development
type: architecture
covers:
  - packages/berth/src/scaffold.ts
  - packages/berth/src/cli.ts
  - packages/berth/test/scaffold.test.ts
  - packages/berth/test/e2e-claude-adapter.test.ts
depends_on:
  - docs/wiki/architecture.md
  - docs/wiki/adapter-author-guide.md
last_verified: 2026-07-13
---

## Repository layout

```
agentic-tools/
├── packages/
│   └── berth/
│       ├── adapters/          runtime-specific shims
│       ├── scripts/           trunk guard + orchestrator scripts
│       ├── src/               TypeScript implementation
│       │   ├── cli.ts         CLI router (parseArgs)
│       │   ├── scaffold.ts    berth init — plan-then-execute installer
│       │   ├── constants.ts   single source of truth for naming
│       │   ├── guard/
│       │   │   └── build-env.ts   buildGuardEnv(isMaster)
│       │   └── pkg-root.ts    walks up to find berth's package root
│       ├── test/              vitest unit + e2e tests
│       ├── package.json
│       └── tsconfig.json
├── docs/
│   └── wiki/                  this directory — veye-tracked docs
├── package.json               workspace root
└── pnpm-workspace.yaml
```

## Build, lint, test

Requires Node.js ≥ 20 and pnpm.

```sh
pnpm install                 # install dependencies
pnpm run ci                  # lint && build && typecheck && test (the full local gate)
pnpm lint                    # eslint
pnpm build                   # TypeScript build to packages/berth/dist/
pnpm typecheck               # tsc --noEmit
pnpm test                    # vitest run
pnpm test:coverage           # vitest run --coverage
pnpm format                  # prettier --write .
```

The aggregate gate script is named `ci`, but bare `pnpm ci` is intercepted by
pnpm's reserved (not-yet-implemented) `ci` subcommand on recent pnpm
versions, so run it as `pnpm run ci`.

## Git hooks

This repo ships a `lefthook.yml` that runs `eslint --fix` and `prettier` on
staged files pre-commit and `typecheck` pre-push. To enable it:

```sh
pnpm exec lefthook install
```

## Test layout

Tests live in `packages/berth/test/` and use **vitest**. The notable files:

| File                                                      | What it covers                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `require-worktree.test.ts`                                | The shell guard's decision table                                               |
| `scaffold.test.ts`                                        | The init function — atomic, idempotent, fail-closed semantics                  |
| `scaffold-orchestrator.test.ts`                           | `--with-orchestrator` flag wiring                                              |
| `cli-router.test.ts`                                      | `parseArgs` routing + exit codes                                               |
| `orchestrator-scripts.test.ts`                            | Orchestration subcommand → script mapping                                      |
| `build-env.test.ts`                                       | `buildGuardEnv` master and non-master env scrub                                |
| `e2e-claude-adapter.test.ts`                              | End-to-end Claude adapter: real Node spawn, real guard script, real stdin JSON |
| `packages/berth/test/adapters/claude-extract.test.ts`     | Claude extract function pure unit                                              |
| `packages/berth/test/adapters/opencode-build-env.test.ts` | OpenCode inlined build-env unit                                                |
| `packages/berth/test/adapters/pi-extract.test.ts`         | Pi extract function pure unit                                                  |

The end-to-end Claude adapter test is the highest-leverage test — it spawns
the real adapter with a real Claude Code event payload, the real guard
script, and asserts the exit code. Adapter tests that only mock the runtime
can miss loader-level bugs that this test catches.

## Conventions

### No comments in code unless absolutely necessary

This is a hard rule across the codebase. The code is the documentation;
high-level explanations live in this docs directory, tracked by veye.

### Single source of truth for naming

Every env var, command verb, and user-facing string is derived from the
constants in `packages/berth/src/constants.ts`. The shell guard mirrors
these env-var names by hand because it runs before any TypeScript is
compiled. Keep the two in lock-step.

### Adapters are self-contained deployable files

Every adapter must run **before** the user has run `pnpm install` or
`pnpm build`. That means:

- No imports from berth's compiled output.
- All helpers inlined (build-env is inlined into the OpenCode adapter).
- Naming constants inlined as string literals.

The naming must stay in sync with `packages/berth/src/constants.ts` and the shell guard.

### Fail-closed by default

Any unexpected error in the guard chain (missing script, spawn error,
unexpected exit code, etc.) **blocks**. The default is deny; the only way
to allow is by satisfying one of the explicit checks in the decision
order. See [threat-model.md](threat-model.md).

### Atomic init

`berth init` plans every write first, writes nothing until every
precondition passes. A precondition failure cannot leave a half-installed
repo behind. See `packages/berth/src/scaffold.ts`.

### Idempotent init

A second run with the guard + requested adapters already in place is a
clean no-op (exit 0, nothing written). The Claude Code settings.json merge
dedupes prior berth hook entries by command match.

### Strict TypeScript

The project uses strict TypeScript. Treat any `any` as a smell. Prefer
precise types via `Record<string, Json>` patterns and explicit guards.

## Releasing

berth is currently `"private": true` and not published to npm. The package
is run from this repo. To distribute:

1. Bump `version` in `packages/berth/package.json`.
2. Run `pnpm --filter berth build` to produce `packages/berth/dist/cli.js`.
3. Tag the commit.
4. (Future) Publish to npm; users run `npx berth init`.

Until then, users install by cloning this repo and running
`pnpm install && pnpm --filter berth build`.

## Adding a new command

1. Add the script under `packages/berth/scripts/` if it has a shell
   component.
2. Add the mapping to `ORCHESTRATOR_SCRIPTS` in `packages/berth/src/cli.ts` if the
   command is an orchestration subcommand.
3. Implement the run function in `packages/berth/src/cli.ts` (or import from
   `packages/berth/src/scaffold.ts` for init-style commands).
4. Add a row to the **Orchestrator commands** table in the README.
5. Add a unit test under `packages/berth/test/`.

## Adding a new kpi_param or config option

`berth init` writes a default veye config; berth itself reads no config.
If you add a new runtime option to the orchestrator:

1. Add the flag to `parseArgs` in `packages/berth/src/cli.ts`.
2. Add the env var name to `packages/berth/src/constants.ts` and mirror it in any shell
   scripts that read it.
3. Document it in the README's **Init** and **Orchestrator** sections.
4. Add tests for the new flag's behavior.

## Related

- [Architecture](architecture.md)
- [Adapter author guide](adapter-author-guide.md)
- [Threat model](threat-model.md)
- [Glossary](glossary.md)
