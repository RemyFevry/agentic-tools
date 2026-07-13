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

import { init } from "../src/scaffold.js";

const execFileP = promisify(execFile);

async function git(args: string[]): Promise<void> {
  await execFileP("git", args, { maxBuffer: 1024 * 1024 });
}

async function makePrimaryRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await git(["init", "-q", "-b", "main", dir]);
  await git(["-C", dir, "config", "user.email", "orch-test@example.com"]);
  await git(["-C", dir, "config", "user.name", "Orch Test"]);
  await git(["-C", dir, "config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "README.md"), "initial\n");
  await git(["-C", dir, "add", "README.md"]);
  await git(["-C", dir, "commit", "-q", "-m", "initial"]);
}

describe("scaffold.init --with-orchestrator (mock-free, real tempdirs)", () => {
  let sandbox: string;
  let target: string;

  beforeEach(async () => {
    sandbox = mkdtempSync(join(tmpdir(), "berth-orch-"));
    target = join(sandbox, "repo");
    await makePrimaryRepo(target);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("writes master agent defs + orchestration scripts + guard + adapters", () => {
    const r = init({ target, withOrchestrator: true });

    expect(r.alreadyInstalled).toBe(false);
    expect(r.orchestratorInstalled).toBe(true);

    // Guard + adapters still present.
    expect(existsSync(join(target, "scripts", "require-worktree.sh"))).toBe(
      true,
    );
    expect(
      existsSync(join(target, ".claude", "hooks", "worktree-guard.mjs")),
    ).toBe(true);

    // Master agent definitions for each runtime.
    expect(existsSync(join(target, ".claude", "agents", "master.md"))).toBe(
      true,
    );
    expect(existsSync(join(target, ".opencode", "agent", "master.md"))).toBe(
      true,
    );
    expect(existsSync(join(target, ".pi", "prompts", "master.md"))).toBe(true);

    // Orchestration scripts (executable).
    for (const name of [
      "master.sh",
      "spawn-layer1.sh",
      "spawn-layer2.sh",
      "feat.sh",
      "ship.sh",
    ]) {
      const p = join(target, "scripts", name);
      expect(existsSync(p)).toBe(true);
      expect(statSync(p).mode & 0o777).toBe(0o755);
    }
  });

  it("master agent defs contain BERTH_ and NO FIL_", () => {
    init({ target, withOrchestrator: true });

    for (const path of [
      join(target, ".claude", "agents", "master.md"),
      join(target, ".opencode", "agent", "master.md"),
      join(target, ".pi", "prompts", "master.md"),
    ]) {
      const content = readFileSync(path, "utf8");
      expect(content).toContain("BERTH_");
      expect(content).not.toMatch(/\bFIL_/);
    }
  });

  it("--runtime claude --with-orchestrator writes only the claude master def", () => {
    init({ target, runtimes: ["claude"], withOrchestrator: true });

    expect(existsSync(join(target, ".claude", "agents", "master.md"))).toBe(
      true,
    );
    // No opencode/pi master defs created.
    expect(existsSync(join(target, ".opencode", "agent"))).toBe(false);
    expect(existsSync(join(target, ".pi", "prompts"))).toBe(false);
    // Orchestration scripts are runtime-independent — always written.
    expect(existsSync(join(target, "scripts", "master.sh"))).toBe(true);
  });

  it("merges orchestrator pnpm scripts into an existing package.json", () => {
    // Pre-existing package.json with unrelated scripts.
    writeFileSync(
      join(target, "package.json"),
      JSON.stringify(
        {
          name: "my-repo",
          scripts: { build: "tsc", test: "vitest" },
        },
        null,
        2,
      ),
    );

    init({ target, withOrchestrator: true });

    const pkg = JSON.parse(
      readFileSync(join(target, "package.json"), "utf8"),
    ) as {
      name: string;
      scripts: Record<string, string>;
    };

    // Pre-existing scripts preserved.
    expect(pkg.name).toBe("my-repo");
    expect(pkg.scripts["build"]).toBe("tsc");
    expect(pkg.scripts["test"]).toBe("vitest");

    // Orchestrator scripts merged in.
    expect(pkg.scripts["master"]).toBe("bash scripts/master.sh");
    expect(pkg.scripts["layer1"]).toBe("bash scripts/spawn-layer1.sh");
    expect(pkg.scripts["layer2"]).toBe("bash scripts/spawn-layer2.sh");
    expect(pkg.scripts["feat"]).toBe("bash scripts/feat.sh");
    expect(pkg.scripts["ship"]).toBe("bash scripts/ship.sh");
  });

  it("does not fail when the target has no package.json (pnpm merge skipped)", () => {
    expect(existsSync(join(target, "package.json"))).toBe(false);
    const r = init({ target, withOrchestrator: true });
    expect(r.alreadyInstalled).toBe(false);
    expect(r.orchestratorInstalled).toBe(true);
    // No package.json was created.
    expect(existsSync(join(target, "package.json"))).toBe(false);
  });

  it("is idempotent: a second --with-orchestrator run is a clean no-op", () => {
    const first = init({ target, withOrchestrator: true });
    expect(first.alreadyInstalled).toBe(false);

    const before = first.writtenFiles.map((f) => statSync(f).mtimeMs);

    const second = init({ target, withOrchestrator: true });
    expect(second.alreadyInstalled).toBe(true);
    expect(second.writtenFiles).toEqual([]);
    expect(second.orchestratorInstalled).toBe(true);
    expect(second.message).toContain("already installed");

    const after = first.writtenFiles.map((f) => statSync(f).mtimeMs);
    expect(after).toEqual(before);
  });

  it("--force overwrites the orchestrator install (mtime advances)", async () => {
    init({ target, withOrchestrator: true });
    const masterAgent = join(target, ".opencode", "agent", "master.md");
    const before = statSync(masterAgent).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 25));

    init({ target, withOrchestrator: true, force: true });
    const after = statSync(masterAgent).mtimeMs;
    expect(after).toBeGreaterThan(before);
  });

  it("aborts atomically on a partial conflict (writes nothing)", () => {
    // Pre-create one orchestrator script without --force.
    const scriptDest = join(target, "scripts", "master.sh");
    mkdirSync(dirname(scriptDest), { recursive: true });
    writeFileSync(scriptDest, "#!/bin/sh\necho pre-existing\n");

    let thrown: unknown;
    try {
      init({ target, withOrchestrator: true });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("refusing to overwrite");

    // Atomicity: nothing else was written.
    expect(existsSync(join(target, ".opencode", "agent", "master.md"))).toBe(
      false,
    );
    expect(existsSync(join(target, "scripts", "spawn-layer1.sh"))).toBe(false);
  });

  it("guard-only init (no --with-orchestrator) writes no orchestrator files", () => {
    const r = init({ target });
    expect(r.orchestratorInstalled).toBe(false);
    expect(existsSync(join(target, "scripts", "master.sh"))).toBe(false);
    expect(existsSync(join(target, ".claude", "agents", "master.md"))).toBe(
      false,
    );
  });
});
