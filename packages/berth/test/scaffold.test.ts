import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ALL_RUNTIMES,
  InitError,
  init,
  parseRuntimes,
} from "../src/scaffold.js";

const execFileP = promisify(execFile);

async function git(args: string[]): Promise<void> {
  await execFileP("git", args, { maxBuffer: 1024 * 1024 });
}

/** `git init` a fresh primary repo at `dir` with one commit so it's real. */
async function makePrimaryRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await git(["init", "-q", "-b", "main", dir]);
  await git(["-C", dir, "config", "user.email", "scaffold-test@example.com"]);
  await git(["-C", dir, "config", "user.name", "Scaffold Test"]);
  await git(["-C", dir, "config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "README.md"), "initial\n");
  await git(["-C", dir, "add", "README.md"]);
  await git(["-C", dir, "commit", "-q", "-m", "initial"]);
}

type ExecError = NodeJS.ErrnoException & {
  code?: number | string;
  stdout?: string;
  stderr?: string;
};

interface GuardResult {
  code: number;
  stderr: string;
}

/** Run the guard at `guardPath` in `cwd` with both master hatches unset. */
async function runInstalledGuard(
  cwd: string,
  guardPath: string,
  cmd: string,
): Promise<GuardResult> {
  const env = { ...process.env };
  delete env.BERTH_ALLOW_MAIN_WORKTREE;
  delete env.BERTH_MASTER_SESSION;
  try {
    await execFileP("bash", [guardPath, cmd], {
      cwd,
      env,
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stderr: "" };
  } catch (e) {
    const err = e as ExecError;
    return {
      code: typeof err.code === "number" ? err.code : -1,
      stderr: err.stderr ?? "",
    };
  }
}

function expectInitError(
  fn: () => unknown,
  predicate: (e: InitError) => boolean,
): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(InitError);
  expect(predicate(thrown as InitError)).toBe(true);
}

describe("scaffold.init (mock-free, real tempdirs)", () => {
  let sandbox: string;
  let target: string;

  beforeEach(async () => {
    sandbox = mkdtempSync(join(tmpdir(), "berth-scaffold-"));
    target = join(sandbox, "repo");
    await makePrimaryRepo(target);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("installs the guard + all three adapters into a git repo", () => {
    const r = init({ target });

    expect(r.alreadyInstalled).toBe(false);
    expect(r.runtimes).toEqual([...ALL_RUNTIMES]);

    // Guard present and executable (mode 0o755).
    const guard = join(target, "scripts", "require-worktree.sh");
    expect(existsSync(guard)).toBe(true);
    expect(statSync(guard).mode & 0o777).toBe(0o755);

    // All three adapters present.
    expect(
      existsSync(join(target, ".claude", "hooks", "worktree-guard.mjs")),
    ).toBe(true);
    expect(
      existsSync(join(target, ".opencode", "plugins", "worktree-guard.ts")),
    ).toBe(true);
    expect(
      existsSync(join(target, ".pi", "extensions", "worktree-guard.ts")),
    ).toBe(true);

    // Claude Code settings.json carries the PreToolUse matcher.
    const settings = JSON.parse(
      readFileSync(join(target, ".claude", "settings.json"), "utf8"),
    ) as { hooks?: { PreToolUse?: Array<{ matcher?: string }> } };
    const preToolUse = settings.hooks?.PreToolUse ?? [];
    expect(
      preToolUse.some((g) => g.matcher === "Write|Edit|MultiEdit|Bash"),
    ).toBe(true);
  });

  it("--runtime claude writes only the claude adapter + settings", () => {
    const r = init({ target, runtimes: ["claude"] });

    expect(r.runtimes).toEqual(["claude"]);
    expect(
      existsSync(join(target, ".claude", "hooks", "worktree-guard.mjs")),
    ).toBe(true);
    expect(existsSync(join(target, ".claude", "settings.json"))).toBe(true);

    // No opencode / pi directories created.
    expect(existsSync(join(target, ".opencode"))).toBe(false);
    expect(existsSync(join(target, ".pi"))).toBe(false);
  });

  it("is idempotent: a second run is a no-op and changes no mtimes", () => {
    const first = init({ target, runtimes: ["claude"] });
    expect(first.alreadyInstalled).toBe(false);

    const before = first.writtenFiles.map((f) => statSync(f).mtimeMs);

    const second = init({ target, runtimes: ["claude"] });
    expect(second.alreadyInstalled).toBe(true);
    expect(second.writtenFiles).toEqual([]);
    expect(second.message).toContain("already installed");

    const after = first.writtenFiles.map((f) => statSync(f).mtimeMs);
    expect(after).toEqual(before);
  });

  it("--force overwrites the existing install (mtime advances)", async () => {
    init({ target, runtimes: ["claude"] });
    const guard = join(target, "scripts", "require-worktree.sh");
    const before = statSync(guard).mtimeMs;

    // Filesystem mtimes have ms resolution; sleep to guarantee an advance.
    await new Promise((resolve) => setTimeout(resolve, 25));

    init({ target, runtimes: ["claude"], force: true });
    const after = statSync(guard).mtimeMs;
    expect(after).toBeGreaterThan(before);
  });

  it("rejects a non-git target with a clear message and writes nothing", () => {
    const noGit = mkdtempSync(join(tmpdir(), "berth-nogit-"));
    try {
      expectInitError(
        () => init({ target: noGit }),
        (e) => e.exitCode === 1 && /not a git repo/.test(e.message),
      );
      // Nothing was written.
      expect(existsSync(join(noGit, "scripts"))).toBe(false);
      expect(existsSync(join(noGit, ".claude"))).toBe(false);
    } finally {
      rmSync(noGit, { recursive: true, force: true });
    }
  });

  it("merges into a pre-existing settings.json, preserving unrelated hooks", () => {
    const settingsPath = join(target, ".claude", "settings.json");
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          permissions: { allow: ["Bash(git:*)"] },
          hooks: {
            PreToolUse: [
              {
                matcher: "Write",
                hooks: [{ type: "command", command: "echo other-hook" }],
              },
            ],
          },
        },
        null,
        2,
      ),
    );

    init({ target, runtimes: ["claude"] });

    const merged = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      permissions: { allow: string[] };
      hooks: {
        PreToolUse: Array<{
          matcher: string;
          hooks: Array<{ type: string; command: string }>;
        }>;
      };
    };

    // Unrelated top-level key preserved.
    expect(merged.permissions.allow).toContain("Bash(git:*)");

    const preToolUse = merged.hooks.PreToolUse;
    // The pre-existing unrelated hook is preserved.
    expect(
      preToolUse.some((g) =>
        g.hooks.some((h) => h.command === "echo other-hook"),
      ),
    ).toBe(true);
    // berth's own hook was added.
    expect(
      preToolUse.some((g) =>
        g.hooks.some((h) =>
          h.command.includes(".claude/hooks/worktree-guard.mjs"),
        ),
      ),
    ).toBe(true);
  });

  it("aborts atomically on a partial conflict (writes nothing else)", () => {
    // Pre-create one adapter file without --force.
    const ocDest = join(target, ".opencode", "plugins", "worktree-guard.ts");
    mkdirSync(dirname(ocDest), { recursive: true });
    writeFileSync(ocDest, "// pre-existing hand-rolled adapter\n");

    expectInitError(
      () => init({ target }),
      (e) =>
        e.exitCode === 1 &&
        /refusing to overwrite/.test(e.message) &&
        /--force/.test(e.message),
    );

    // Atomicity: nothing else was written.
    expect(existsSync(join(target, "scripts", "require-worktree.sh"))).toBe(
      false,
    );
    expect(
      existsSync(join(target, ".claude", "hooks", "worktree-guard.mjs")),
    ).toBe(false);
    expect(existsSync(join(target, ".pi"))).toBe(false);
  });

  it("the installed guard BLOCKs a mutation in the primary (exit 2)", async () => {
    init({ target, runtimes: ["claude"] });
    const guard = join(target, "scripts", "require-worktree.sh");

    const r = await runInstalledGuard(target, guard, "echo hi");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("protected");
    expect(r.stderr).toContain("wt switch -c <branch>");
  });
});

describe("parseRuntimes", () => {
  it("returns all runtimes for an empty spec", () => {
    expect(parseRuntimes("")).toEqual([...ALL_RUNTIMES]);
    expect(parseRuntimes("   ")).toEqual([...ALL_RUNTIMES]);
    expect(parseRuntimes(" , , ")).toEqual([...ALL_RUNTIMES]);
  });

  it("parses + de-duplicates a comma-separated subset", () => {
    expect(parseRuntimes("claude,opencode")).toEqual(["claude", "opencode"]);
    expect(parseRuntimes("pi, pi ,claude")).toEqual(["pi", "claude"]);
  });

  it("rejects an unknown runtime name with exit 1", () => {
    expectInitError(
      () => parseRuntimes("claude,bogus"),
      (e) => e.exitCode === 1 && /unknown runtime 'bogus'/.test(e.message),
    );
  });
});
