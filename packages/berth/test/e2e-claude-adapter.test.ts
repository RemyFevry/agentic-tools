//
// Real-node E2E for the Claude Code adapter.
//
// Spawns actual `node` subprocesses to exercise the module loader — catching
// import bugs (wrong-module named exports) that vitest's transpiler masks.
// The adapter is scaffolded into a real git repo via the built CLI, then
// exercised with stdin JSON the same way Claude Code invokes it.
//

import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileP = promisify(execFile);

const CLI_BIN = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

async function git(args: string[]): Promise<void> {
  await execFileP("git", args, { maxBuffer: 1024 * 1024 });
}

interface AdapterResult {
  status: number | null;
  stderr: string;
}

/**
 * Spawn real `node` on the scaffolded adapter, feeding `eventJson` on stdin.
 * Returns the REAL node exit status (null on signal).
 */
function runAdapter(
  cwd: string,
  adapterPath: string,
  eventJson: string,
  envOverride: Record<string, string | undefined> = {},
): AdapterResult {
  // Scrub berth hatches from the test process first, then apply per-test
  // overrides (which may intentionally re-set a hatch).
  const baseEnv: NodeJS.ProcessEnv = { ...process.env };
  delete baseEnv.BERTH_ALLOW_MAIN_WORKTREE;
  delete baseEnv.BERTH_MASTER_SESSION;
  delete baseEnv.BERTH_GATE_SCRIPT;
  const env = { ...baseEnv, ...envOverride };
  const result = spawnSync("node", [adapterPath], {
    cwd,
    env,
    input: eventJson,
    encoding: "utf8",
    timeout: 15000,
  });
  return {
    status: result.status,
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

describe("Claude adapter E2E (real node subprocesses)", () => {
  // Skip entirely if dist/cli.js hasn't been built (CI always builds first).
  const cliBuilt = existsSync(CLI_BIN);

  let sandbox: string;
  let primary: string;
  let linked: string;
  let adapterPath: string;

  beforeAll(async () => {
    sandbox = mkdtempSync(join(tmpdir(), "berth-e2e-claude-"));

    // 1. Fresh git repo (primary checkout).
    primary = join(sandbox, "primary");
    mkdirSync(primary, { recursive: true });
    await git(["init", "-q", "-b", "main", primary]);
    await git(["-C", primary, "config", "user.name", "e2e-test"]);
    await git(["-C", primary, "config", "user.email", "e2e@example.com"]);
    await git(["-C", primary, "config", "commit.gpgsign", "false"]);

    // 2. Scaffold the guard + Claude adapter via the built CLI.
    const scaffoldResult = spawnSync(
      "node",
      [CLI_BIN, "init", primary, "--runtime", "claude"],
      {
        encoding: "utf8",
        timeout: 15000,
      },
    );
    if (scaffoldResult.status !== 0) {
      throw new Error(`berth init failed: ${scaffoldResult.stderr}`);
    }

    adapterPath = join(primary, ".claude", "hooks", "worktree-guard.mjs");
    if (!existsSync(adapterPath)) {
      throw new Error(`adapter not scaffolded at ${adapterPath}`);
    }

    // 3. Commit so the repo is real (and worktree add works).
    await git(["-C", primary, "add", "-A"]);
    await git(["-C", primary, "commit", "-q", "-m", "init"]);

    // 4. Create a linked worktree for the worktree-allow test.
    linked = join(sandbox, "linked");
    await git(["-C", primary, "worktree", "add", linked, "-b", "linked"]);
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  // Conditional skip wrapper.
  const e2eIt = cliBuilt ? it : it.skip;

  e2eIt("module loads under real node (no import crash)", () => {
    // If the import were broken, spawnSync would get status 1 with a
    // SyntaxError in stderr — not the guard's exit 2.
    const r = runAdapter(
      primary,
      adapterPath,
      '{"tool_name":"Bash","tool_input":{"command":"echo hi"}}',
    );
    // Even in the primary (blocked), the adapter itself must not crash.
    // Status 2 = guard blocked (adapter ran fine). Status 1 = crash.
    expect(r.status).not.toBe(1);
  });

  e2eIt("primary + Bash mutating → status 2 (blocked)", () => {
    const r = runAdapter(
      primary,
      adapterPath,
      '{"tool_name":"Bash","tool_input":{"command":"echo hi > f"}}',
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("protected");
  });

  e2eIt("primary + Edit → status 2 (blocked)", () => {
    const r = runAdapter(
      primary,
      adapterPath,
      '{"tool_name":"Edit","tool_input":{}}',
    );
    expect(r.status).toBe(2);
  });

  e2eIt("primary + whitelisted wt verb → status 0 (allowed)", () => {
    const r = runAdapter(
      primary,
      adapterPath,
      '{"tool_name":"Bash","tool_input":{"command":"wt switch -c feat/x"}}',
    );
    expect(r.status).toBe(0);
  });

  e2eIt(
    "primary + BERTH_ALLOW_MAIN_WORKTREE=1 + Bash → status 0 (hatch)",
    () => {
      const r = runAdapter(
        primary,
        adapterPath,
        '{"tool_name":"Bash","tool_input":{"command":"echo hi > f"}}',
        { BERTH_ALLOW_MAIN_WORKTREE: "1" },
      );
      expect(r.status).toBe(0);
    },
  );

  e2eIt(
    "primary + smuggled command (`wt switch foo; rm -rf /`) → status 2",
    () => {
      const r = runAdapter(
        primary,
        adapterPath,
        '{"tool_name":"Bash","tool_input":{"command":"wt switch foo; rm -rf /"}}',
      );
      expect(r.status).toBe(2);
    },
  );

  e2eIt("linked worktree + Bash mutating → status 0 (worktree allows)", () => {
    const r = runAdapter(
      linked,
      join(linked, ".claude", "hooks", "worktree-guard.mjs"),
      '{"tool_name":"Bash","tool_input":{"command":"echo hi > f"}}',
    );
    expect(r.status).toBe(0);
  });
});
