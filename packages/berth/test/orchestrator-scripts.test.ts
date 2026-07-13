import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileP = promisify(execFile);

const SCRIPTS_DIR = fileURLToPath(new URL("../scripts/", import.meta.url));

function scriptPath(name: string): string {
  return join(SCRIPTS_DIR, name);
}

function readScript(name: string): string {
  return readFileSync(scriptPath(name), "utf8");
}

type ExecError = NodeJS.ErrnoException & {
  code?: number | string;
  stdout?: string;
  stderr?: string;
};

describe("orchestration scripts — prefix + structure", () => {
  const SCRIPT_NAMES = [
    "master.sh",
    "spawn-layer1.sh",
    "spawn-layer2.sh",
    "feat.sh",
    "ship.sh",
  ] as const;

  it.each(SCRIPT_NAMES)("%s exists and is executable (mode 0o755)", (name) => {
    const p = scriptPath(name);
    expect(existsSync(p)).toBe(true);
    expect(statSync(p).mode & 0o777).toBe(0o755);
  });

  it.each(SCRIPT_NAMES)("%s contains NO FIL_", (name) => {
    const content = readScript(name);
    // No FIL_ leak — the whole word boundary.
    expect(content).not.toMatch(/\bFIL_/);
  });

  // master.sh + spawn-layer1/2.sh reference BERTH_ env vars; feat.sh/ship.sh
  // drive only wt/herdr (no berth env vars by design).
  it.each(["master.sh", "spawn-layer1.sh", "spawn-layer2.sh"] as const)(
    "%s uses BERTH_ prefix",
    (name) => {
      expect(readScript(name)).toContain("BERTH_");
    },
  );

  it("spawn-layer1.sh unsets both hatches (defense in depth)", () => {
    const content = readScript("spawn-layer1.sh");
    expect(content).toContain(
      "unset BERTH_ALLOW_MAIN_WORKTREE BERTH_MASTER_SESSION",
    );
  });

  it("spawn-layer2.sh unsets both hatches (defense in depth)", () => {
    const content = readScript("spawn-layer2.sh");
    expect(content).toContain(
      "unset BERTH_ALLOW_MAIN_WORKTREE BERTH_MASTER_SESSION",
    );
  });

  it("master.sh exports BERTH_ALLOW_MAIN_WORKTREE=1", () => {
    const content = readScript("master.sh");
    expect(content).toContain("export BERTH_ALLOW_MAIN_WORKTREE=1");
  });

  it("master.sh never writes the hatch into repo/shell config", () => {
    // The hatch must be process-only — never persisted via echo, cat, or
    // shell-config writes.
    const content = readScript("master.sh");
    expect(content).not.toMatch(/echo.*BERTH_ALLOW_MAIN_WORKTREE.*>>/);
    expect(content).not.toMatch(/cat.*BERTH_ALLOW_MAIN_WORKTREE/);
  });
});

describe("master.sh dry-run", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "berth-master-dry-"));
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  async function runMasterDryRun(
    cwd: string,
    runtime: string | undefined,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const args = [scriptPath("master.sh")];
    if (runtime !== undefined) args.push(runtime);
    try {
      const { stdout, stderr } = await execFileP("bash", args, {
        cwd,
        env: { ...process.env, BERTH_MASTER_DRY_RUN: "1" },
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

  it("prints runtime + hatch and exits 0 WITHOUT launching (default opencode)", async () => {
    const r = await runMasterDryRun(sandbox, undefined);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("berth master launcher (dry run)");
    expect(r.stdout).toContain("opencode");
    expect(r.stdout).toContain("BERTH_ALLOW_MAIN_WORKTREE");
    expect(r.stdout).toContain("1");
  });

  it("honours an explicit runtime argument (claude)", async () => {
    const r = await runMasterDryRun(sandbox, "claude");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("claude");
  });

  it("honours pi runtime", async () => {
    const r = await runMasterDryRun(sandbox, "pi");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("pi");
  });

  it("does NOT launch the runtime in dry-run mode", async () => {
    // A non-existent runtime passed in dry-run should still exit 0 (it never
    // reaches the exec).
    const r = await runMasterDryRun(sandbox, "/nonexistent/runtime/xyz");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("/nonexistent/runtime/xyz");
  });
});
