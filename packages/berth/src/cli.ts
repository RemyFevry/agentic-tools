#!/usr/bin/env node
//
// berth CLI entry — a `util.parseArgs` router.
//
// Subcommands:
//   init     install the trunk guard (+ optional orchestrator) into a repo
//   master   launch the layer-0 master session in the primary checkout
//   layer1   master spawns a layer-1 subagent (new tab + new worktree)
//   layer2   a layer-1 spawns a layer-2 subagent (pane split, shared worktree)
//   feat     open a Change in a linked worktree (+ optional herdr workspace)
//   ship     close a Change: merge the worktree (+ optional herdr close)
//
// Unknown (or missing) subcommand prints usage and exits 1. Exit codes mirror
// the scaffolder: 0 success / already installed, 1 precondition error, 2
// unexpected. Orchestration subcommands exit with the script's exit code.
//
// Run directly:  node packages/berth/dist/cli.js init ./my-repo --runtime claude

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { findPkgRoot } from "./pkg-root.js";
import {
  ALL_RUNTIMES,
  EXIT_OK,
  EXIT_PRECONDITION,
  EXIT_UNEXPECTED,
  InitError,
  init,
  parseRuntimes,
  type InitResult,
  type Runtime,
} from "./scaffold.js";

// --- orchestration subcommand → script mapping --------------------------------

/**
 * Maps an orchestration subcommand to the script file (relative to the berth
 * package root) it should exec. Exported so tests can verify the routing
 * without spawning.
 */
export const ORCHESTRATOR_SCRIPTS = {
  master: "scripts/master.sh",
  layer1: "scripts/spawn-layer1.sh",
  layer2: "scripts/spawn-layer2.sh",
  feat: "scripts/feat.sh",
  ship: "scripts/ship.sh",
} as const satisfies Record<string, string>;

/** Valid orchestration subcommand names. */
export type OrchestratorSubcommand = keyof typeof ORCHESTRATOR_SCRIPTS;

/** True when `s` is a known orchestration subcommand. */
export function isOrchestratorSubcommand(
  s: string,
): s is OrchestratorSubcommand {
  return Object.prototype.hasOwnProperty.call(ORCHESTRATOR_SCRIPTS, s);
}

/**
 * Resolve the absolute path to the script backing `subcommand`. Throws a plain
 * Error if the package root cannot be located.
 */
export function resolveOrchestratorScript(
  subcommand: OrchestratorSubcommand,
): string {
  return join(findPkgRoot(), ORCHESTRATOR_SCRIPTS[subcommand]);
}

// --- usage -------------------------------------------------------------------

const USAGE = `berth — trunk guard + orchestrator

Usage:
  berth init [target] [--runtime <list>] [--force] [--with-orchestrator]
  berth master [runtime]
  berth layer1 <name> <branch> [runtime]
  berth layer2 <name> [runtime]
  berth feat <branch>
  berth ship

Subcommands:
  init       install the trunk guard + adapters into a repo
  master     launch the layer-0 master orchestrator in the primary checkout
  layer1     master spawns a layer-1 subagent (new tab + new worktree)
  layer2     a layer-1 spawns a layer-2 subagent (pane split, shared worktree)
  feat       open a Change in a linked worktree (+ optional herdr workspace)
  ship       close a Change: merge the worktree (+ optional herdr close)

Init options:
  --runtime <list>       comma-separated subset of: claude,opencode,pi  (default: all)
  --force                overwrite an existing install
  --with-orchestrator    also install the master agent defs + spawn scripts
  -h, --help             show this help

Runtime (master/layer1/layer2): opencode (default) | claude | pi

Exit codes:
  0  success (or already installed)
  1  precondition error (not a git repo, conflict, bad args)
  2  unexpected error
`;

function printUsage(stream: NodeJS.WriteStream): void {
  stream.write(USAGE);
}

// --- init formatting ---------------------------------------------------------

/** Per-runtime follow-up note shown after a successful install. */
function runtimeNote(rt: Runtime): string {
  switch (rt) {
    case "claude":
      return "restart your Claude Code session to load the PreToolUse hook.";
    case "opencode":
      return "ensure `@opencode-ai/plugin` is available in your project.";
    case "pi":
      return "restart Pi to load the extension.";
  }
}

/** Format a successful (or no-op) install result for stdout. */
function formatResult(r: InitResult): string {
  const lines: string[] = [];
  if (r.alreadyInstalled) {
    lines.push(r.message);
    return `${lines.join("\n")}\n`;
  }

  lines.push(r.message, "");
  lines.push("Files written:");
  for (const abs of r.writtenFiles) {
    const rel = relative(r.target, abs) || abs;
    lines.push(`  ${rel}`);
  }
  lines.push("", `Guard script: ${r.guardPath}`, "", "Next steps:");
  for (const rt of r.runtimes) {
    lines.push(`  ${rt.padEnd(8)}  ${runtimeNote(rt)}`);
  }
  if (r.orchestratorInstalled) {
    lines.push(
      "",
      "Orchestrator installed. Start a master session:",
      "  berth master [runtime]",
    );
  } else {
    lines.push(
      "",
      "The guard blocks edits in the primary checkout. Move work into a linked worktree:",
      "  wt switch -c <branch>",
    );
  }
  return `${lines.join("\n")}\n`;
}

// --- router ------------------------------------------------------------------

/** The option values shape produced by `parseArgs` in {@link main}. */
interface CliValues {
  runtime?: string;
  force?: boolean;
  withOrchestrator?: boolean;
  help?: boolean;
}

function runInit(positionals: string[], values: CliValues): void {
  const target = positionals[1] ?? process.cwd();
  const force = values.force === true;
  const withOrchestrator = values.withOrchestrator === true;

  let runtimes: readonly Runtime[];
  try {
    runtimes = values.runtime ? parseRuntimes(values.runtime) : ALL_RUNTIMES;
  } catch (e) {
    const err = e as InitError;
    process.stderr.write(`${err.message}\n`);
    process.exit(err.exitCode);
  }

  let result: InitResult;
  try {
    result = init({ target, runtimes, force, withOrchestrator });
  } catch (e) {
    if (e instanceof InitError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(e.exitCode);
    }
    process.stderr.write(`berth: unexpected error: ${String(e)}\n`);
    process.exit(EXIT_UNEXPECTED);
  }

  process.stdout.write(formatResult(result));
  process.exit(EXIT_OK);
}

/**
 * Resolve + exec the orchestration script for `subcommand`, forwarding
 * `args` (the remaining positionals). Exits with the script's exit code.
 */
function runOrchestrator(
  subcommand: OrchestratorSubcommand,
  args: string[],
): void {
  let scriptPath: string;
  try {
    scriptPath = resolveOrchestratorScript(subcommand);
  } catch (e) {
    process.stderr.write(`${String(e)}\n`);
    process.exit(EXIT_UNEXPECTED);
  }
  if (!existsSync(scriptPath)) {
    process.stderr.write(`berth: template missing: ${scriptPath}\n`);
    process.exit(EXIT_UNEXPECTED);
  }

  const result = spawnSync("bash", [scriptPath, ...args], {
    stdio: "inherit",
  });
  if (result.signal) {
    process.stderr.write(`berth: ${subcommand}: killed by ${result.signal}\n`);
    process.exit(EXIT_UNEXPECTED);
  }
  process.exit(result.status ?? EXIT_UNEXPECTED);
}

function main(): void {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        runtime: { type: "string" },
        force: { type: "boolean" },
        withOrchestrator: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    process.stderr.write(`berth: ${(e as Error).message}\n`);
    printUsage(process.stderr);
    process.exit(EXIT_PRECONDITION);
  }
  const { values, positionals } = parsed;

  if (values.help) {
    printUsage(process.stdout);
    process.exit(EXIT_OK);
  }

  const subcommand = positionals[0];
  if (subcommand === undefined) {
    printUsage(process.stderr);
    process.exit(EXIT_PRECONDITION);
  }

  if (subcommand === "init") {
    runInit(positionals, values);
    return;
  }

  if (isOrchestratorSubcommand(subcommand)) {
    runOrchestrator(subcommand, positionals.slice(1));
    return;
  }

  process.stderr.write(`berth: unknown subcommand '${subcommand}'\n`);
  printUsage(process.stderr);
  process.exit(EXIT_PRECONDITION);
}

// Run only when invoked directly as the CLI entry, not when imported (for
// tests). Mirrors the guard pattern in adapters/claude/worktree-guard.mjs.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
