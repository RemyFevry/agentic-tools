#!/usr/bin/env node
//
// berth trunk-guard adapter — Claude Code PreToolUse hook (Node ESM).
//
// Self-contained deployable: when `berth init` wires a target repo, this file
// is copied verbatim into `.claude/hooks/`. Do NOT import from berth's compiled
// output; every helper is inlined below.
//
// Source of truth for the decision: scripts/require-worktree.sh.
//
// Contract:
//   stdin  -> JSON { tool_name, tool_input }
//   exit 0 -> allow the tool call
//   exit 2 -> block the tool call (the guard's stderr is forwarded to stderr)
//   any other code / spawn error / missing guard -> exit 2 (fail closed)
//
// Adapters NEVER reimplement the decision. They extract the command string the
// caller is about to run and delegate to the guard.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

// --- naming (mirror of scripts/require-worktree.sh / src/constants.ts) -------
const ENV_PREFIX = "BERTH_";
const GATE_SCRIPT_ENV = `${ENV_PREFIX}GATE_SCRIPT`;
const GATE_SCRIPT_REL = "scripts/require-worktree.sh";

/**
 * Extract the bash command string from a Claude Code PreToolUse event.
 *
 * Bash carries its command in `tool_input.command`; every other tool
 * (Edit/Write/...) has no command and resolves to "" so the guard falls
 * straight through to the worktree check. Missing/non-string fields resolve
 * to "".
 *
 * Pure + side-effect free so it can be unit-tested in isolation.
 *
 * @param {unknown} event
 * @returns {string}
 */
export function extractClaudeCommand(event) {
  if (!event || typeof event !== "object") return "";
  const e = /** @type {Record<string, unknown>} */ (event);
  if (e.tool_name !== "Bash") return "";
  const toolInput = e.tool_input;
  if (!toolInput || typeof toolInput !== "object") return "";
  const command = /** @type {Record<string, unknown>} */ (toolInput).command;
  return typeof command === "string" ? command : "";
}

/**
 * Resolve the gate script path (shared rule):
 *   - `BERTH_GATE_SCRIPT` (absolute path) wins;
 *   - else `<repo-root>/scripts/require-worktree.sh`;
 *   - null if it can't be located.
 */
function resolveGateScript() {
  const fromEnv = process.env[GATE_SCRIPT_ENV];
  if (fromEnv) return fromEnv;
  let toplevel;
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

function spawnGate(gatePath, command) {
  try {
    return spawnSync("bash", [gatePath, command], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  } catch (e) {
    throw new Error(`berth: failed to run the trunk guard: ${String(e)}`);
  }
}

function failClosed(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function runHook() {
  let raw;
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    return failClosed(
      "berth: could not read PreToolUse JSON on stdin. Blocking.",
    );
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return failClosed("berth: invalid PreToolUse JSON on stdin. Blocking.");
  }

  const command = extractClaudeCommand(event);

  const gatePath = resolveGateScript();
  if (!gatePath) {
    return failClosed(
      `berth: could not locate the trunk-guard script (set ${GATE_SCRIPT_ENV} or run inside a git repo). Blocking.`,
    );
  }

  let result;
  try {
    result = spawnGate(gatePath, command);
  } catch (e) {
    return failClosed(String(e));
  }

  if (result.error) {
    return failClosed(
      `berth: failed to run the trunk guard: ${String(result.error)}`,
    );
  }

  // Forward the guard's stderr so the user sees the block reason.
  if (typeof result.stderr === "string" && result.stderr.length > 0) {
    process.stderr.write(result.stderr);
  }

  // 0 -> allow; 2 (or anything else, or null/signal) -> fail closed.
  if (result.status === 0) process.exit(0);
  process.exit(2);
}

// Run only when invoked directly as a script; importing the module (for tests)
// must NOT trigger the hook. realpathSync resolves symlinks (e.g. macOS
// /tmp → /private/tmp) so the comparison matches import.meta.url, which
// Node resolves to the real path.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  try {
    runHook();
  } catch {
    // set -e-style safety: any unexpected throw fails closed.
    process.exit(2);
  }
}
