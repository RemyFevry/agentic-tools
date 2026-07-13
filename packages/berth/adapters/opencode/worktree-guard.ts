//
// berth trunk-guard adapter — OpenCode plugin (agent-aware REFERENCE impl).
//
// Self-contained deployable: when `berth init` wires a target repo, this file
// is copied verbatim into `.opencode/plugins/`. Do NOT import from berth's
// compiled output; every helper is inlined below.
//
// Source-of-truth pointers (keep in lock-step):
//   - gate decision:  scripts/require-worktree.sh
//   - env build:      src/guard/build-env.ts  (buildGuardEnv is inlined here)
//
// Adapters NEVER reimplement the decision. They extract the command string the
// caller is about to run and delegate to the guard. Unlike the Claude/Pi
// adapters (which forward `process.env` unchanged), this one is AGENT-AWARE:
// it tracks the active agent per session and builds the guard env so a
// non-master can never satisfy a master hatch by inheritance.

import {
  execFileSync,
  spawnSync,
  type SpawnSyncReturns,
} from "node:child_process";

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

/** The agent name trusted to run inside the primary checkout. */
const MASTER_AGENT = "master";

/**
 * Build the environment a guarded child process should run with.
 *
 * Inlined copy of `src/guard/build-env.ts` (that file is the source of truth —
 * keep them identical).
 *
 * - master session: inherit the parent env AND assert master status by setting
 *   `BERTH_MASTER_SESSION=1`.
 * - non-master session: inherit the parent env BUT delete BOTH master hatches
 *   (`BERTH_ALLOW_MAIN_WORKTREE` and `BERTH_MASTER_SESSION`) so a non-master
 *   can never satisfy either hatch merely by inheritance.
 *
 * Unrelated keys are always preserved. The input env is never mutated.
 */
export function buildGuardEnv(processEnv: Env, isMaster: boolean): Env {
  const env: Env = { ...processEnv };
  if (isMaster) {
    env[MASTER_SESSION_ENV] = "1";
  } else {
    delete env[ALLOW_MAIN_WORKTREE_ENV];
    delete env[MASTER_SESSION_ENV];
  }
  return env;
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
): SpawnSyncReturns<string> {
  try {
    return spawnSync("bash", [gatePath, command], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  } catch (e) {
    throw new Error(`berth: failed to run the trunk guard: ${String(e)}`);
  }
}

/**
 * Run the guard for `command` under `env`. Throws (fails closed) on exit 2, any
 * unexpected code, spawn error, or missing gate. Returns normally on exit 0
 * (allow). The thrown message embeds the guard's stderr.
 */
function runGate(command: string, env: Env): void {
  const gatePath = resolveGateScript();
  if (!gatePath) {
    throw new Error(
      `berth: could not locate the trunk-guard script (set ${GATE_SCRIPT_ENV} or run inside a git repo). Blocking.`,
    );
  }
  const result = spawnGate(gatePath, command, env);
  if (result.error) {
    throw new Error(
      `berth: failed to run the trunk guard: ${String(result.error)}`,
    );
  }
  if (result.status === 0) return;
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  throw new Error(
    `berth: blocked — ${stderr || "trunk guard denied the command"}`,
  );
}

// --- minimal OpenCode plugin API shapes (this repo ships no OpenCode types) --

interface OpenCodeToolArgs {
  command?: string;
}
interface OpenCodeToolOutput {
  args?: OpenCodeToolArgs;
}
interface OpenCodeChatEvent {
  sessionId?: string;
  agentName?: string;
}
interface OpenCodeToolEvent {
  tool?: string;
  sessionId?: string;
  output?: OpenCodeToolOutput;
}
interface OpenCodePluginApi {
  on(event: "chat.message", handler: (e: OpenCodeChatEvent) => void): unknown;
  on(
    event: "tool.execute.before",
    handler: (e: OpenCodeToolEvent) => unknown,
  ): unknown;
}

/**
 * Extract the command a guarded tool is about to run. Bash carries its command
 * in `output.args.command`; edit/write pass "".
 */
function extractOpenCodeCommand(event: OpenCodeToolEvent): string {
  const command = event.output?.args?.command;
  return typeof command === "string" ? command : "";
}

/**
 * OpenCode plugin (default export). Maintains the active-agent map and
 * registers the pre-tool veto point.
 */
export default function worktreeGuard(opencode: OpenCodePluginApi): void {
  const activeAgentForSession = new Map<string, string>();

  opencode.on("chat.message", (event) => {
    const { sessionId, agentName } = event;
    if (typeof sessionId === "string" && typeof agentName === "string") {
      activeAgentForSession.set(sessionId, agentName);
    }
  });

  opencode.on("tool.execute.before", (event) => {
    const tool = event.tool;
    if (!tool || !GUARDED_TOOLS.has(tool)) return undefined;
    const command = extractOpenCodeCommand(event);
    const isMaster =
      activeAgentForSession.get(event.sessionId ?? "") === MASTER_AGENT;
    const env = buildGuardEnv(process.env as Env, isMaster);
    runGate(command, env); // throws -> fail closed
    return undefined; // exit 0 -> allow
  });
}
