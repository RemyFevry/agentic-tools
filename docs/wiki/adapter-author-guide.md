---
veye: true
title: berth adapter author guide
type: component
covers:
  - packages/berth/adapters/claude/worktree-guard.mjs
  - packages/berth/adapters/opencode/worktree-guard.ts
  - packages/berth/adapters/pi/worktree-guard.ts
depends_on:
  - docs/wiki/architecture.md
  - docs/wiki/threat-model.md
last_verified: 2026-07-13
---

---

## The adapter contract

An adapter is a runtime-specific shim that feeds the canonical trunk guard.
Each adapter:

1. **Extracts** the command string the caller is about to run (empty for
   edit and write tools).
2. **Resolves** the path to the guard script (`packages/berth/scripts/require-worktree.sh`).
3. **Shells out** to the guard with that command.
4. **Fails closed** on exit 2 or any unexpected error.

That's it. **Adapters never reimplement the decision.** They extract and
delegate. If you find yourself wanting to add a rule to an adapter, add it to
`packages/berth/scripts/require-worktree.sh` instead — the single source of truth.

## The three existing adapters

| Adapter         | Runtime                                         | How it hooks                                        |
| --------------- | ----------------------------------------------- | --------------------------------------------------- |
| **Claude Code** | PreToolUse hook (Node ESM, reads JSON on stdin) | adapter file in `packages/berth/adapters/claude/`   |
| **OpenCode**    | Plugin (agent-aware reference)                  | adapter file in `packages/berth/adapters/opencode/` |
| **Pi**          | Extension (reads JSON on stdin)                 | adapter file in `packages/berth/adapters/pi/`       |

The OpenCode adapter is the **agent-aware reference implementation**: it
tracks the active agent per session and builds the guard env so a non-master
can never satisfy a master hatch by inheritance. The Claude and Pi adapters
forward `process.env` unchanged — they rely on the spawn scripts (the master
launcher and the layer-1 and layer-2 launchers) having set or unset the
hatches correctly.

## Gate-path resolution — the shared rule

Every adapter uses the same two-step resolution:

1. If `BERTH_GATE_SCRIPT` (absolute path) is set, use it.
2. Else resolve the repo root via `git rev-parse --show-toplevel` and use
   `packages/berth/scripts/require-worktree.sh` relative to that.

If neither works, the adapter fails closed. The path resolution is small
enough to be inlined — adapters are **self-contained deployable files**, so
they cannot import from berth's compiled output.

## Step-by-step: writing a new adapter

### 1. Identify the runtime's pre-tool hook point

Every supported runtime exposes some form of "about to run a tool" callback.
Find yours.

- Claude Code: `PreToolUse` hook (in the target repo's `settings.json`); receives JSON on
  stdin; exit 2 blocks.
- OpenCode: plugin API with `tool.execute.before` event; throws or returns
  undefined to allow.
- Pi: extension API; receives JSON; throws or returns to allow.
- Codex, Cursor, Aider, Continue.dev: each has its own surface. Look for
  `PreToolUse`, `beforeToolCall`, or equivalent.

### 2. Extract the command string

For a `Bash` tool, the command is somewhere on the event payload. For an
edit or write tool, it is **empty** (no command was about to be executed —
only a file mutation). The three existing adapters' extract functions are
the model:

- Claude: `extractClaudeCommand`
- OpenCode: `extractOpenCodeCommand`
- Pi: `extractPiCommand`

The pattern (generic):

```typescript
function extractCommand(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  // Find the bash tool's command field.
  // Return "" for any other tool.
  // Return "" if the field is missing or non-string.
}
```

### 3. Resolve the guard script (inline the helper)

Copy the `resolveGateScript` function from any existing adapter. It is small
enough to inline:

```typescript
function resolveGateScript(): string | null {
  const fromEnv = process.env[`BERTH_GATE_SCRIPT`];
  if (fromEnv) return fromEnv;
  let toplevel: string;
  try {
    toplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
  if (!toplevel) return null;
  return `${toplevel}/scripts/require-worktree.sh`;
}
```

### 4. Shell out to the guard and translate the exit code

```typescript
function runGate(command: string): "allow" | "block" {
  const gatePath = resolveGateScript();
  if (!gatePath) return "block"; // fail closed on missing guard
  const result = spawnSync("bash", [gatePath, command], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (result.error) return "block"; // spawn failed
  if (result.status === 0) return "allow";
  return "block"; // anything else = block, including exit 2
}
```

### 5. Wire it into the runtime's hook point

Translate the "allow" or "block" result into whatever the runtime expects:

- **Claude Code / Pi (PreToolUse-style hooks):** exit 0 = allow, exit 2 =
  block. Forward the guard's stderr.
- **OpenCode (plugin API):** return `undefined` to allow, throw to block.
  Embed the guard's stderr in the throw message.

### 6. Make the file self-contained

The adapter is **copied verbatim** into the target repo by `berth init`.
That means:

- **No imports from berth's compiled output.** The adapter must run before
  the user has run `pnpm install` or `pnpm build`.
- **All helpers inlined.** `buildGuardEnv` is inlined into the OpenCode
  adapter as a deliberate copy. The naming constants are inlined as string
  literals. Keep these in lock-step with `packages/berth/src/constants.ts`.

### 7. Register the runtime in `packages/berth/src/scaffold.ts`

Add a new entry to the `ALL_RUNTIMES` constant and the `Runtime` union type.
Add entries to `adapterSources` and `adapterDestinations`:

```typescript
function adapterSources(pkgRoot: string): Record<Runtime, string> {
  return {
    // ...existing
    "<your-runtime>": join(
      pkgRoot,
      "adapters",
      "<your-runtime>",
      "worktree-guard.<ext>",
    ),
  };
}

function adapterDestinations(target: string): Record<Runtime, string> {
  return {
    // ...existing
    "<your-runtime>": join(
      target,
      ".<runtime-config-dir>",
      "worktree-guard.<ext>",
    ),
  };
}
```

If the runtime has a master-agent definition, also add to `masterAgentSources`
and `masterAgentDestinations`.

### 8. Add an installation note in the CLI

In `packages/berth/src/cli.ts`, `runtimeNote()` returns the follow-up message shown after
install:

```typescript
case "<your-runtime>":
  return "<what the user needs to do to activate the hook>";
```

### 9. Add tests

The three existing adapters each have a test file under
`packages/berth/test/adapters/`:

- `claude-extract.test.ts` — unit test for the extract function (pure,
  side-effect free)
- `opencode-build-env.test.ts` — unit test for the inlined `buildGuardEnv`
- `pi-extract.test.ts` — unit test for the extract function

Add a `<your-runtime>-extract.test.ts` covering the extraction function. The
extraction function is the only adapter logic that is safe to unit-test in
isolation; the rest depends on the runtime's hook API.

### 10. Update the README

Add a row to the **Adapters** table.

## Adapter anti-patterns

- **Do not reimplement the decision** in the adapter. Add the rule to
  `packages/berth/scripts/require-worktree.sh` instead.
- **Do not import from berth's compiled output.** The adapter must run in
  the target repo before any build step.
- **Do not mutate `process.env` to scrub master hatches in a non-master
  agent adapter** unless you are the OpenCode adapter. The Claude and Pi
  adapters rely on the spawn scripts having done this. If you add a new
  non-agent-aware runtime, copy the Claude or Pi model.
- **Do not silently swallow errors.** Fail closed: if the guard script
  errors, block.
- **Do not write a "dry run" or "audit" mode that allows.** Audit belongs in
  the guard script itself, which can take an env flag to log instead of
  block.

## Self-test checklist

Before merging a new adapter:

- The unit test suite passes (the new extract function has unit tests).
- Manual test in a linked worktree: the adapter allows a `Bash` tool.
- Manual test in the primary: the adapter blocks a `Bash` tool with the
  guard's stderr forwarded.
- Manual test of edit and write tools in the primary: blocked.
- Manual test of `wt switch -c foo` in the primary: allowed (bootstrap
  whitelist).
- `pnpm --filter berth build && pnpm --filter berth test` is clean.

## Related

- [Architecture](architecture.md)
- [Threat model](threat-model.md)
- [Development](development.md)
