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
//
// OpenCode plugin contract (@opencode-ai/plugin):
//   A plugin is an async function `(input: PluginInput) => Promise<Hooks>`.
//   OpenCode discovers it as a **named export** from the module. Hooks receive
//   two arguments (input, output):
//     - "chat.message":        input  = { sessionID, agent?, ... }
//     - "tool.execute.before": input  = { tool, sessionID, callID }
//                              output = { args }
//   Throwing inside "tool.execute.before" blocks the tool call (fail closed).
//   Types are imported from `@opencode-ai/plugin` so this can't silently drift.

import type { Plugin } from "@opencode-ai/plugin";
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

/** The agent name trusted to orchestrate (run bash) inside the primary checkout. */
const ORCHESTRATOR_AGENT = "orchestrator";

/**
 * Build the environment a guarded child process should run with.
 *
 * Inlined copy of `src/guard/build-env.ts` (that file is the source of truth —
 * keep them identical).
 *
 * - orchestrator session: inherit the parent env AND assert orchestrator status
 *   by setting `BERTH_MASTER_SESSION=1`.
 * - non-orchestrator session: inherit the parent env BUT delete BOTH hatches
 *   (`BERTH_ALLOW_MAIN_WORKTREE` and `BERTH_MASTER_SESSION`) so a non-orchestrator
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
 * Run the guard for `command` under `env`. Throws (fails closed) on exit 2, any
 * unexpected code, spawn error, or missing gate. Returns normally on exit 0
 * (allow). The thrown message embeds the guard's stderr.
 */
function runGate(command: string, env: Env, cwd?: string): void {
  const gatePath = resolveGateScript();
  if (!gatePath) {
    throw new Error(
      `berth: could not locate the trunk-guard script (set ${GATE_SCRIPT_ENV} or run inside a git repo). Blocking.`,
    );
  }
  const result = spawnGate(gatePath, command, env, cwd);
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

/**
 * Extract the command a guarded tool is about to run. The bash tool carries its
 * command in `output.args.command`; edit/write pass "".
 *
 * Pure + side-effect free so it can be unit-tested in isolation.
 */
export function extractOpenCodeCommand(args: unknown): string {
  if (args && typeof args === "object" && "command" in args) {
    const cmd = (args as Record<string, unknown>).command;
    return typeof cmd === "string" ? cmd : "";
  }
  return "";
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
 * Extract the target working directory from a tool call's args, so the guard
 * checks the directory the tool will actually operate in — not just
 * `process.cwd()`. This lets a master agent on main safely target a linked
 * worktree (the guard sees `.git` as a file → allows).
 *
 *   bash     → args.workdir or args.cwd
 *   write/edit → dirname(args.filePath) or dirname(args.path)
 *   fallback → undefined (caller uses process.cwd())
 */
export function extractWorkDir(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  const direct =
    typeof a.workdir === "string"
      ? a.workdir
      : typeof a.cwd === "string"
        ? a.cwd
        : undefined;
  if (direct) return validDir(direct);
  const filePath =
    typeof a.filePath === "string"
      ? a.filePath
      : typeof a.path === "string"
        ? a.path
        : undefined;
  if (filePath) return validDir(dirname(filePath));
  return undefined;
}

/**
 * OpenCode plugin (named export). Maintains the active-agent map per session and
 * registers the pre-tool veto point. **Throws** inside `tool.execute.before` to
 * block a mutating tool call in the primary checkout (fail closed); returns
 * normally to allow.
 *
 * An agent with no registered name (no `chat.message` received yet) defaults to
 * **orchestrator** — it's the layer-0 agent that owns the primary checkout.
 *
 * The orchestrator is trusted for **bash only** (orchestration commands).
 * Edit/write are NEVER given the hatch — the orchestrator delegates file
 * mutations to subagents in worktrees.
 */
export const WorktreeGuard: Plugin = async () => {
  const activeAgentForSession = new Map<string, string>();

  return {
    "chat.message": async (input) => {
      if (input.agent) {
        activeAgentForSession.set(input.sessionID, input.agent);
      }
    },
    "tool.execute.before": async (input, output) => {
      if (!GUARDED_TOOLS.has(input.tool)) return;
      const command = extractOpenCodeCommand(output.args);
      const cwd = extractWorkDir(output.args);
      const agent = activeAgentForSession.get(input.sessionID);
      const isOrchestrator =
        agent === undefined || agent === ORCHESTRATOR_AGENT;
      // Orchestrator gets the hatch for bash only. Edit/write always go
      // through the worktree check (blocked in primary, allowed in worktree).
      const trusted = isOrchestrator && input.tool === "bash";
      runGate(command, buildGuardEnv(process.env as Env, trusted), cwd);
    },
  };
};
