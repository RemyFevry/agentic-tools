// `berth init` scaffolder — installs the canonical trunk guard + the requested
// runtime adapters into a target git repo.
//
// Design rules (see TASK / docs):
//   - Plan every write first; write nothing until every precondition passes
//     (atomic — never half-install).
//   - Idempotent: a second run with the guard + requested adapters already in
//     place is a clean no-op (exit 0, nothing written).
//   - Fail-closed on non-git targets and on unforced overwrites (exit 1).
//   - The Claude Code settings.json hook is MERGED, never clobbered.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { TOOL_NAME } from "./constants.js";
import { findPkgRoot } from "./pkg-root.js";

/** Runtimes berth can wire an adapter for. */
export type Runtime = "claude" | "opencode" | "pi";

/** All supported runtimes, in canonical order. */
export const ALL_RUNTIMES = ["claude", "opencode", "pi"] as const;

/** Valid runtime names, for fast membership checks. */
const VALID_RUNTIMES: ReadonlySet<Runtime> = new Set<Runtime>(ALL_RUNTIMES);

/**
 * Exit codes used by the scaffolder.
 *   0 = success (or already installed)
 *   1 = precondition error (not a git repo, conflict, bad args)
 *   2 = unexpected error
 */
export const EXIT_OK = 0;
export const EXIT_PRECONDITION = 1;
export const EXIT_UNEXPECTED = 2;

/** Options accepted by {@link init}. */
export interface InitOptions {
  /** Repo path to install into. Resolved to an absolute path. */
  target: string;
  /** Subset of runtimes to wire. Defaults to {@link ALL_RUNTIMES}. */
  runtimes?: readonly Runtime[];
  /** Overwrite an existing install. */
  force?: boolean;
  /** Also install the master agent defs + orchestration scripts.
   * @deprecated Always installed now; this flag is accepted for backward
   *   compatibility but has no effect. */
  withOrchestrator?: boolean;
}

/** Structured result of an {@link init} run. */
export interface InitResult {
  /** True when the install was a no-op (already installed). */
  alreadyInstalled: boolean;
  /** Absolute path of the resolved target. */
  target: string;
  /** Absolute paths of files written this run (empty on no-op). */
  writtenFiles: string[];
  /** Absolute path of the installed guard script. */
  guardPath: string;
  /** Runtimes wired this run. */
  runtimes: readonly Runtime[];
  /** True when the orchestrator (agent defs + scripts) is installed. */
  orchestratorInstalled: boolean;
  /** Single-line, user-facing status message. */
  message: string;
}

/**
 * Error carrying the process exit code the CLI should use.
 */
export class InitError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
  ) {
    super(message);
    this.name = "InitError";
  }
}

// --- Claude Code settings.json merge (PreToolUse hook) -----------------------

/** Tools the trunk-guard hook must vet in Claude Code. */
const CLAUDE_HOOK_MATCHER = "Write|Edit|MultiEdit|Bash";

/** Command the merged hook runs (resolves the adapter via the project dir). */
const CLAUDE_HOOK_COMMAND =
  "node $CLAUDE_PROJECT_DIR/.claude/hooks/worktree-guard.mjs";

/**
 * A permissive JSON value, used so the merge is fully type-safe without `any`.
 */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A JSON object (records only — arrays are handled separately). */
type JsonObject = { [key: string]: Json };

/**
 * Merge berth's PreToolUse hook into `<target>/.claude/settings.json`,
 * preserving every existing key and hook. Any prior berth hook entry (matched
 * by command) is replaced with the canonical one, so the result is exactly one
 * berth hook no matter how many times this runs.
 */
function mergeClaudeSettings(settingsPath: string): void {
  let settings: JsonObject = {};
  if (existsSync(settingsPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        settings = parsed as JsonObject;
      }
    } catch {
      // Malformed settings.json — start from a clean object rather than
      // clobbering the file wholesale. (Fail-open on shape, fail-closed on
      // semantics: berth's own hook is still added.)
      settings = {};
    }
  }

  const hooksVal = settings["hooks"];
  const hooks: JsonObject =
    hooksVal && typeof hooksVal === "object" && !Array.isArray(hooksVal)
      ? (hooksVal as JsonObject)
      : {};
  settings["hooks"] = hooks;

  const ptuVal = hooks["PreToolUse"];
  const existing: Json[] = Array.isArray(ptuVal) ? (ptuVal as Json[]) : [];

  // Drop any prior berth hook entry (by command), keep everything else verbatim.
  const cleaned: Json[] = [];
  for (const group of existing) {
    if (isBerthHookGroup(group)) continue;
    cleaned.push(group);
  }
  cleaned.push({
    matcher: CLAUDE_HOOK_MATCHER,
    hooks: [{ type: "command", command: CLAUDE_HOOK_COMMAND }],
  });
  hooks["PreToolUse"] = cleaned;

  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

/** True when a PreToolUse group contains berth's canonical hook command. */
function isBerthHookGroup(group: Json): boolean {
  if (!group || typeof group !== "object" || Array.isArray(group)) return false;
  const g = group as JsonObject;
  const hookList = g["hooks"];
  if (!Array.isArray(hookList)) return false;
  return (hookList as Json[]).some((h) => {
    if (!h || typeof h !== "object" || Array.isArray(h)) return false;
    return (h as JsonObject)["command"] === CLAUDE_HOOK_COMMAND;
  });
}

// --- package-root resolution -------------------------------------------------

// findPkgRoot is imported from ./pkg-root.js (shared with the CLI router).

// --- runtime parsing ---------------------------------------------------------

/**
 * Parse a comma-separated `--runtime` spec into a de-duplicated, validated
 * list of runtimes. An empty/whitespace spec resolves to all runtimes.
 *
 * @throws {InitError} exit 1 on an unknown runtime name.
 */
export function parseRuntimes(spec: string): Runtime[] {
  const parts = spec
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return [...ALL_RUNTIMES];
  const seen = new Set<Runtime>();
  for (const part of parts) {
    if (!VALID_RUNTIMES.has(part as Runtime)) {
      throw new InitError(
        `${TOOL_NAME}: unknown runtime '${part}' (valid: claude, opencode, pi)`,
        EXIT_PRECONDITION,
      );
    }
    seen.add(part as Runtime);
  }
  return [...seen];
}

// --- the installer -----------------------------------------------------------

interface CopyOp {
  src: string;
  dest: string;
  /** Mode to force after copy (the guard must be executable). */
  mode?: number;
}

/** Map each runtime to its source adapter template. */
function adapterSources(pkgRoot: string): Record<Runtime, string> {
  return {
    claude: join(pkgRoot, "adapters", "claude", "worktree-guard.mjs"),
    opencode: join(pkgRoot, "adapters", "opencode", "worktree-guard.ts"),
    pi: join(pkgRoot, "adapters", "pi", "worktree-guard.ts"),
  };
}

/** Map each runtime to its destination path inside the target repo. */
function adapterDestinations(target: string): Record<Runtime, string> {
  return {
    claude: join(target, ".claude", "hooks", "worktree-guard.mjs"),
    opencode: join(target, ".opencode", "plugins", "worktree-guard.ts"),
    pi: join(target, ".pi", "extensions", "worktree-guard.ts"),
  };
}

// --- orchestrator sources / destinations -------------------------------------

/** The five orchestration scripts, in canonical order. */
const ORCHESTRATOR_SCRIPT_NAMES = [
  "master.sh",
  "spawn-layer1.sh",
  "spawn-layer2.sh",
  "feat.sh",
  "ship.sh",
] as const;

/** Map each runtime to its source orchestrator-agent-definition template. */
function orchestratorAgentSources(pkgRoot: string): Record<Runtime, string> {
  return {
    claude: join(pkgRoot, "adapters", "claude", "orchestrator.md"),
    opencode: join(pkgRoot, "adapters", "opencode", "orchestrator.md"),
    pi: join(pkgRoot, "adapters", "pi", "orchestrator.md"),
  };
}

/** Map each runtime to its destination orchestrator-agent path inside the target. */
function orchestratorAgentDestinations(
  target: string,
): Record<Runtime, string> {
  return {
    claude: join(target, ".claude", "agents", "orchestrator.md"),
    opencode: join(target, ".opencode", "agent", "orchestrator.md"),
    pi: join(target, ".pi", "prompts", "orchestrator.md"),
  };
}

/** pnpm convenience scripts registered when the orchestrator is installed. */
const ORCHESTRATOR_PNPM_SCRIPTS: Record<string, string> = {
  master: "bash scripts/master.sh",
  layer1: "bash scripts/spawn-layer1.sh",
  layer2: "bash scripts/spawn-layer2.sh",
  feat: "bash scripts/feat.sh",
  ship: "bash scripts/ship.sh",
};

/**
 * Merge the orchestrator convenience scripts into the target's
 * `package.json`, preserving every existing script key. Returns the path to
 * the written `package.json` (added to {@link InitResult.writtenFiles}), or
 * `null` when the target has no `package.json` (or it is malformed).
 */
function mergeOrchestratorPnpmScripts(target: string): string | null {
  const pkgPath = join(target, "package.json");
  if (!existsSync(pkgPath)) return null;
  let pkg: JsonObject;
  try {
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    pkg = parsed as JsonObject;
  } catch {
    return null;
  }
  const scriptsVal = pkg["scripts"];
  const scripts: JsonObject =
    scriptsVal && typeof scriptsVal === "object" && !Array.isArray(scriptsVal)
      ? (scriptsVal as JsonObject)
      : {};
  pkg["scripts"] = scripts;
  for (const [key, val] of Object.entries(ORCHESTRATOR_PNPM_SCRIPTS)) {
    scripts[key] = val;
  }
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  return pkgPath;
}

/**
 * Install the trunk guard + the requested runtime adapters into `target`.
 *
 * Synchronous on purpose: the plan-then-execute ordering must be deterministic
 * so a precondition failure can never leave a half-installed repo behind.
 *
 * @throws {InitError} exit 1 on precondition failure, exit 2 on the unexpected.
 */
export function init(options: InitOptions): InitResult {
  const force = options.force === true;
  const withOrchestrator = true; // Always install the orchestrator.
  const runtimes =
    options.runtimes && options.runtimes.length > 0
      ? options.runtimes
      : [...ALL_RUNTIMES];
  const target = resolve(options.target);

  // 1. Target must exist and be a directory.
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(target);
  } catch {
    throw new InitError(
      `${TOOL_NAME}: ${target} does not exist`,
      EXIT_PRECONDITION,
    );
  }
  if (!st.isDirectory()) {
    throw new InitError(
      `${TOOL_NAME}: ${target} is not a directory`,
      EXIT_PRECONDITION,
    );
  }

  // 2. Git check — the guard only applies to git repos.
  if (!existsSync(join(target, ".git"))) {
    throw new InitError(
      `${TOOL_NAME}: ${target} is not a git repo (the guard only applies to git repos)`,
      EXIT_PRECONDITION,
    );
  }

  // 3. Locate the source templates relative to berth's package root.
  let pkgRoot: string;
  try {
    pkgRoot = findPkgRoot();
  } catch (e) {
    throw new InitError(String(e), EXIT_UNEXPECTED);
  }
  const guardSrc = join(pkgRoot, "scripts", "require-worktree.sh");
  const srcMap = adapterSources(pkgRoot);
  const orchestratorSrcMap = withOrchestrator
    ? orchestratorAgentSources(pkgRoot)
    : null;
  const orchestratorScriptSrcs = withOrchestrator
    ? ORCHESTRATOR_SCRIPT_NAMES.map((n) => join(pkgRoot, "scripts", n))
    : [];
  const requiredTemplates = [
    guardSrc,
    ...runtimes.map((r) => srcMap[r]),
    ...(orchestratorSrcMap ? runtimes.map((r) => orchestratorSrcMap[r]) : []),
    ...orchestratorScriptSrcs,
  ];
  for (const path of requiredTemplates) {
    if (!existsSync(path)) {
      throw new InitError(
        `${TOOL_NAME}: template missing: ${path}`,
        EXIT_UNEXPECTED,
      );
    }
  }

  // 4. Plan every write.
  const destMap = adapterDestinations(target);
  const guardDest = join(target, "scripts", "require-worktree.sh");
  const copies: CopyOp[] = [
    { src: guardSrc, dest: guardDest, mode: 0o755 },
    ...runtimes.map((r) => ({ src: srcMap[r], dest: destMap[r] })),
  ];
  if (withOrchestrator) {
    const orchestratorDestMap = orchestratorAgentDestinations(target);
    copies.push(
      ...ORCHESTRATOR_SCRIPT_NAMES.map((name) => ({
        src: join(pkgRoot, "scripts", name),
        dest: join(target, "scripts", name),
        mode: 0o755,
      })),
      ...runtimes.map((r) => ({
        src: orchestratorSrcMap![r],
        dest: orchestratorDestMap[r],
      })),
    );
  }
  const wireClaude = runtimes.includes("claude");

  // 5. Idempotency: gate + all requested adapters already in place -> no-op.
  const allPresent = copies.every((c) => existsSync(c.dest));
  if (allPresent && !force) {
    return {
      alreadyInstalled: true,
      target,
      writtenFiles: [],
      guardPath: guardDest,
      runtimes,
      orchestratorInstalled: withOrchestrator,
      message: `${TOOL_NAME}: already installed (use --force to overwrite)`,
    };
  }

  // 6. Conflict: some (but not all) destinations exist and --force is unset.
  if (!force) {
    const conflict = copies.find((c) => existsSync(c.dest));
    if (conflict) {
      const rel = relative(target, conflict.dest) || conflict.dest;
      throw new InitError(
        `${TOOL_NAME}: refusing to overwrite existing file ${rel} (use --force to overwrite)`,
        EXIT_PRECONDITION,
      );
    }
  }

  // 7. Execute. mkdir -p each directory first, then copy, then chmod the guard.
  const writtenFiles: string[] = [];
  for (const op of copies) {
    mkdirSync(dirname(op.dest), { recursive: true });
    copyFileSync(op.src, op.dest);
    if (op.mode !== undefined) chmodSync(op.dest, op.mode);
    writtenFiles.push(op.dest);
  }

  // 8. Merge the Claude Code PreToolUse hook (preserves existing settings).
  if (wireClaude) {
    const settingsPath = join(target, ".claude", "settings.json");
    mkdirSync(dirname(settingsPath), { recursive: true });
    mergeClaudeSettings(settingsPath);
    writtenFiles.push(settingsPath);
  }

  // 9. Merge orchestrator convenience scripts into the target's package.json.
  if (withOrchestrator) {
    const pkgPath = mergeOrchestratorPnpmScripts(target);
    if (pkgPath) writtenFiles.push(pkgPath);
  }

  return {
    alreadyInstalled: false,
    target,
    writtenFiles,
    guardPath: guardDest,
    runtimes,
    orchestratorInstalled: withOrchestrator,
    message: `${TOOL_NAME}: installed trunk guard into ${target}`,
  };
}
