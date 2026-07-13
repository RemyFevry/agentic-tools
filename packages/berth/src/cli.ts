#!/usr/bin/env node
//
// berth CLI entry — a thin `util.parseArgs` router around `init()`.
//
// Only `init` exists today; an unknown (or missing) subcommand prints usage and
// exits 1. Exit codes mirror the scaffolder: 0 success / already installed,
// 1 precondition error, 2 unexpected.
//
// Run directly:  node packages/berth/dist/cli.js init ./my-repo --runtime claude

import { parseArgs } from "node:util";
import { relative } from "node:path";

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

const USAGE = `berth — trunk guard scaffolder

Usage:
  berth init [target] [--runtime <list>] [--force]

Arguments:
  target     repo path to install into (default: current directory)

Options:
  --runtime <list>  comma-separated subset of: claude,opencode,pi  (default: all)
  --force           overwrite an existing install
  -h, --help        show this help

Exit codes:
  0  success (or already installed)
  1  precondition error (not a git repo, conflict, bad args)
  2  unexpected error
`;

function printUsage(stream: NodeJS.WriteStream): void {
  stream.write(USAGE);
}

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
  lines.push(
    "",
    "The guard blocks edits in the primary checkout. Move work into a linked worktree:",
    "  wt switch -c <branch>",
  );
  return `${lines.join("\n")}\n`;
}

function main(): void {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        runtime: { type: "string" },
        force: { type: "boolean" },
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
  if (subcommand !== "init") {
    process.stderr.write(`berth: unknown subcommand '${subcommand}'\n`);
    printUsage(process.stderr);
    process.exit(EXIT_PRECONDITION);
  }

  const target = positionals[1] ?? process.cwd();
  const force = values.force === true;

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
    result = init({ target, runtimes, force });
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

main();
