import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ORCHESTRATOR_SCRIPTS,
  isOrchestratorSubcommand,
  resolveOrchestratorScript,
} from "../src/cli.js";

const execFileP = promisify(execFile);

type ExecError = NodeJS.ErrnoException & {
  code?: number | string;
  stdout?: string;
  stderr?: string;
};

describe("ORCHESTRATOR_SCRIPTS mapping", () => {
  it("maps each subcommand to the right script name", () => {
    expect(ORCHESTRATOR_SCRIPTS.master).toBe("scripts/master.sh");
    expect(ORCHESTRATOR_SCRIPTS.layer1).toBe("scripts/spawn-layer1.sh");
    expect(ORCHESTRATOR_SCRIPTS.layer2).toBe("scripts/spawn-layer2.sh");
    expect(ORCHESTRATOR_SCRIPTS.feat).toBe("scripts/feat.sh");
    expect(ORCHESTRATOR_SCRIPTS.ship).toBe("scripts/ship.sh");
  });

  it("has exactly 5 entries", () => {
    expect(Object.keys(ORCHESTRATOR_SCRIPTS)).toHaveLength(5);
  });
});

describe("isOrchestratorSubcommand", () => {
  it.each(["master", "layer1", "layer2", "feat", "ship"] as const)(
    "returns true for '%s'",
    (sub) => {
      expect(isOrchestratorSubcommand(sub)).toBe(true);
    },
  );

  it.each(["init", "bogus", "", "MASTER", "Layer1", "help"])(
    "returns false for '%s'",
    (sub) => {
      expect(isOrchestratorSubcommand(sub)).toBe(false);
    },
  );
});

describe("resolveOrchestratorScript", () => {
  it("resolves to an existing absolute path for each subcommand", () => {
    for (const sub of ["master", "layer1", "layer2", "feat", "ship"] as const) {
      const path = resolveOrchestratorScript(sub);
      expect(existsSync(path)).toBe(true);
      expect(path).toContain(ORCHESTRATOR_SCRIPTS[sub]);
    }
  });
});

// --- e2e: unknown subcommand exits 1 -----------------------------------------

const CLI_BIN = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

describe("CLI e2e (requires built dist/cli.js)", () => {
  // These tests spawn the built CLI binary. The CI gate builds before testing,
  // so dist/cli.js exists. Skip gracefully if not built (e.g. running tests
  // without a prior build in local dev).
  const cliExists = existsSync(CLI_BIN);
  const maybeIt = cliExists ? it : it.skip;

  async function runCli(
    args: string[],
    envOverride: Record<string, string | undefined> = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileP("node", [CLI_BIN, ...args], {
        env: { ...process.env, ...envOverride },
        maxBuffer: 1024 * 1024,
      });
      return { code: 0, stdout, stderr };
    } catch (e) {
      const err = e as ExecError;
      return {
        code: typeof err.code === "number" ? err.code : -1,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? "",
      };
    }
  }

  maybeIt("unknown subcommand exits 1 with usage on stderr", async () => {
    const r = await runCli(["bogus"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown subcommand");
  });

  maybeIt("no subcommand exits 1 with usage on stderr", async () => {
    const r = await runCli([]);
    expect(r.code).toBe(1);
  });

  maybeIt(
    "master + BERTH_MASTER_DRY_RUN=1 exits 0 and prints dry-run output",
    async () => {
      const r = await runCli(["master", "opencode"], {
        BERTH_MASTER_DRY_RUN: "1",
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("berth master launcher (dry run)");
      expect(r.stdout).toContain("opencode");
      expect(r.stdout).toContain("BERTH_ALLOW_MAIN_WORKTREE");
    },
  );

  maybeIt("layer1 forwards name + branch args to spawn-layer1.sh", async () => {
    // Explicitly unset HERDR_WORKSPACE_ID so spawn-layer1.sh bails at its
    // first precondition check — proving the CLI routed to the right script.
    const r = await runCli(["layer1", "myagent", "feat/123"], {
      BERTH_AGENT_LAYER: "0",
      HERDR_WORKSPACE_ID: undefined,
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("HERDR_WORKSPACE_ID");
  });

  maybeIt("layer2 refuses without HERDR_PANE_ID", async () => {
    const r = await runCli(["layer2", "child"], {
      HERDR_PANE_ID: undefined,
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("HERDR_PANE_ID");
  });
});
