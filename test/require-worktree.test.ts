import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileP = promisify(execFile);

const GUARD = fileURLToPath(
  new URL("../scripts/require-worktree.sh", import.meta.url),
);

type ExecError = NodeJS.ErrnoException & {
  code?: number | string;
  stdout?: string;
  stderr?: string;
};

interface GuardResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the guard in `cwd` with the command the caller is "about to run".
 * `envOverride` is merged on top of the current process environment so each
 * test can toggle the BERTH_* hatches.
 */
async function runGuard(
  cwd: string,
  cmd: string,
  envOverride: Record<string, string> = {},
): Promise<GuardResult> {
  try {
    const { stdout, stderr } = await execFileP("bash", [GUARD, cmd], {
      cwd,
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

async function git(args: string[]): Promise<void> {
  await execFileP("git", args, { maxBuffer: 1024 * 1024 });
}

async function makePrimaryRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(["init", "-q", "-b", "main", dir]);
  await git(["-C", dir, "config", "user.email", "guard-test@example.com"]);
  await git(["-C", dir, "config", "user.name", "Guard Test"]);
  await git(["-C", dir, "config", "commit.gpgsign", "false"]);
  await writeFile(join(dir, "README.md"), "initial\n");
  await git(["-C", dir, "add", "README.md"]);
  await git(["-C", dir, "commit", "-q", "-m", "initial"]);
}

describe("require-worktree.sh (e2e against real git)", () => {
  let sandbox: string;
  let primary: string;
  let linked: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "berth-guard-"));
    primary = join(sandbox, "primary");
    linked = join(sandbox, "linked");
    await makePrimaryRepo(primary);
    await git(["-C", primary, "worktree", "add", "-q", "-b", "feat/x", linked]);
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it("blocks a mutating command in the primary checkout", async () => {
    const r = await runGuard(primary, "rm -rf something");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("protected");
    expect(r.stderr).toContain("wt switch -c <branch>");
  });

  it("allows any command in a linked worktree", async () => {
    const r = await runGuard(linked, "rm -rf something");
    expect(r.code).toBe(0);
  });

  it("allows any command when not inside a git repo", async () => {
    const noGit = await mkdtemp(join(tmpdir(), "berth-nogit-"));
    try {
      const r = await runGuard(noGit, "rm -rf something");
      expect(r.code).toBe(0);
    } finally {
      await rm(noGit, { recursive: true, force: true });
    }
  });

  it("allows when BERTH_ALLOW_MAIN_WORKTREE=1 in the primary", async () => {
    const r = await runGuard(primary, "rm -rf something", {
      BERTH_ALLOW_MAIN_WORKTREE: "1",
    });
    expect(r.code).toBe(0);
  });

  it("allows when BERTH_MASTER_SESSION=1 in the primary", async () => {
    const r = await runGuard(primary, "rm -rf something", {
      BERTH_MASTER_SESSION: "1",
    });
    expect(r.code).toBe(0);
  });

  it("allows a whitelisted verb (`wt switch -c feat/x`) in the primary", async () => {
    const r = await runGuard(primary, "wt switch -c feat/x");
    expect(r.code).toBe(0);
  });

  it("allows several other whitelisted verbs in the primary", async () => {
    for (const cmd of ["wt list", "wt path", "wt log", "wt which"]) {
      const r = await runGuard(primary, cmd);
      expect(r.code).toBe(0);
    }
  });

  it("blocks a command-smuggling string (`wt switch foo; rm -rf /`)", async () => {
    const r = await runGuard(primary, "wt switch foo; rm -rf /");
    expect(r.code).toBe(2);
  });

  it("blocks the excluded `wt merge` verb", async () => {
    const r = await runGuard(primary, "wt merge main");
    expect(r.code).toBe(2);
  });

  it("blocks the excluded `wt remove` verb", async () => {
    const r = await runGuard(primary, "wt remove linked");
    expect(r.code).toBe(2);
  });

  it("blocks shell redirection inside an otherwise-whitelisted command", async () => {
    const r = await runGuard(primary, "wt switch foo > /etc/passwd");
    expect(r.code).toBe(2);
  });

  it("treats an empty command as non-whitelisted and blocks in primary", async () => {
    const r = await runGuard(primary, "");
    expect(r.code).toBe(2);
  });
});
