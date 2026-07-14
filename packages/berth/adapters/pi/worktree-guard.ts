//
// berth trunk-guard adapter — Pi extension.
//
// Self-contained deployable: when `berth init` wires a target repo, this file
// is copied verbatim into `.pi/extensions/`. Do NOT import from berth's
// compiled output; every helper is inlined below.
//
// Source of truth for the decision: scripts/require-worktree.sh.
//
// Adapters NEVER reimplement the decision. They extract the command string the
// caller is about to run and delegate to the guard. Pi forwards `process.env`
// unchanged (the operator/launcher controls the master hatches).

import {
  execFileSync,
  spawnSync,
  type SpawnSyncReturns,
} from "node:child_process";
import { statSync } from "node:fs";
import { dirname } from "node:path";

/** A process environment. */
export type Env = Record<string, string | undefined>;

// Naming (mirror of src/constants.ts; inlined so this file is standalone).
const ENV_PREFIX = "BERTH_";
const ALLOW_MAIN_WORKTREE_ENV = `${ENV_PREFIX}ALLOW_MAIN_WORKTREE`;
const MASTER_SESSION_ENV = `${ENV_PREFIX}MASTER_SESSION`;
const GATE_SCRIPT_ENV = `${ENV_PREFIX}GATE_SCRIPT`;
const GATE_SCRIPT_REL = "scripts/require-worktree.sh";

/** Tools whose execution must be vetted by the trunk guard. */
const GUARDED_TOOLS = new Set(["edit", "write", "bash"]);

/** Observed input shape on a Pi tool_call event. */
export interface PiToolCallInput {
  command?: unknown;
  args?: unknown;
  [key: string]: unknown;
}

/**
 * A Pi tool_call event. The command can land in several places across Pi
 * versions, so every candidate is typed loosely and narrowed at runtime.
 */
export interface PiToolCallEvent {
  toolName?: string;
  input?: PiToolCallInput;
  args?: { command?: unknown };
  command?: unknown;
}

/** Result returned to Pi to block a tool call. */
export interface PiToolCallResult {
  block: boolean;
  reason: string;
}

/** Minimal Pi plugin API surface this extension needs. */
export interface PiPluginApi {
  on(
    event: "tool_call",
    handler: (e: PiToolCallEvent) => PiToolCallResult | undefined | void,
  ): unknown;
}

/**
 * Best-effort command extraction across observed Pi tool_call shapes. Returns
 * the first non-empty string candidate, else "".
 *
 * Fallback order (first non-empty wins):
 *   1. `event.input.command`
 *   2. `event.input.args`
 *   3. `event.args.command`
 *   4. `event.command`
 *
 * Pure + side-effect free so it can be unit-tested in isolation.
 */
export function extractPiCommand(
  event: PiToolCallEvent | null | undefined,
): string {
  if (!event) return "";
  const candidates: unknown[] = [
    event.input?.command,
    event.input?.args,
    event.args?.command,
    event.command,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return "";
}

/**
 * Resolve the gate script path (shared rule):
 *   - `BERTH_GATE_SCRIPT` (absolute path) wins;
 *   - else `<repo-root>/scripts/require-worktree.sh`;
 *   - null if it can't be located.
 */
function resolveGateScript(): string | null {
  const fromEnv = process.env[GATE_SCRIPT_ENV];
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
  return `${toplevel}/${GATE_SCRIPT_REL}`;
}

/** Spawn the guard. Throws (wrapped) on a spawn exception. */
function spawnGate(
  gatePath: string,
  command: string,
  env: Env,
  cwd?: string,
): SpawnSyncReturns<string> {
  try {
    return spawnSync("bash", [gatePath, command], {
      env,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  } catch (e) {
    throw new Error(`berth: failed to run the trunk guard: ${String(e)}`);
  }
}

/**
 * Run the guard for `command` under `env`. Returns `undefined` on exit 0
 * (allow); otherwise a `{ block: true, reason }` carrying the guard's stderr
 * (fail closed on exit 2, unexpected code, spawn error, or missing guard).
 */
function runGate(
  command: string,
  env: Env,
  cwd?: string,
): PiToolCallResult | undefined {
  const gatePath = resolveGateScript();
  if (!gatePath) {
    return {
      block: true,
      reason: `berth: could not locate the trunk-guard script (set ${GATE_SCRIPT_ENV} or run inside a git repo). Blocking.`,
    };
  }
  try {
    const result = spawnGate(gatePath, command, env, cwd);
    if (result.error) {
      return {
        block: true,
        reason: `berth: failed to run the trunk guard: ${String(result.error)}`,
      };
    }
    if (result.status === 0) return undefined;
    const stderr =
      typeof result.stderr === "string" ? result.stderr.trim() : "";
    return {
      block: true,
      reason: stderr || "berth: trunk guard denied the command",
    };
  } catch (e) {
    return {
      block: true,
      reason: `berth: failed to run the trunk guard: ${String(e)}`,
    };
  }
}

/** Return `p` if it is an existing directory, else `undefined`. */
function validDir(p: string | undefined): string | undefined {
  if (!p) return undefined;
  try {
    return statSync(p).isDirectory() ? p : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract the target working directory from a Pi tool_call event, so the guard
 * checks the directory the tool will actually operate in. For write/edit the
 * file path is in `event.input.path`; bash has no per-call workdir in Pi.
 */
export function extractPiWorkDir(
  event: PiToolCallEvent | null | undefined,
): string | undefined {
  if (!event?.input) return undefined;
  const path = event.input.path;
  if (typeof path === "string") return validDir(dirname(path));
  return undefined;
}

/**
 * Pi extension (default-export factory). Registers a `tool_call` listener that
 * vets `edit`/`write`/`bash` against the trunk guard.
 *
 * Edit/write never inherit the orchestrator hatches — the orchestrator
 * delegates file mutations to subagents. Bash forwards env unchanged.
 */
export default function worktreeGuard(pi: PiPluginApi): void {
  pi.on("tool_call", (event) => {
    const tool = event.toolName;
    if (!tool || !GUARDED_TOOLS.has(tool)) return undefined;
    const command = extractPiCommand(event);
    const cwd = extractPiWorkDir(event);
    const env: Env = { ...process.env };
    if (tool !== "bash") {
      delete env[ALLOW_MAIN_WORKTREE_ENV];
      delete env[MASTER_SESSION_ENV];
    }
    return runGate(command, env, cwd);
  });
}
