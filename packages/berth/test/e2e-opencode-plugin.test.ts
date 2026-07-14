//
// E2E for the OpenCode WorktreeGuard plugin.
//
// Exercises the REAL plugin contract: calls WorktreeGuard() to obtain a Hooks
// object, then invokes the registered "tool.execute.before" / "chat.message"
// hooks against live git repos. This catches the exact bug from issue #2 — a
// plugin that doesn't register hooks is silently inert.
//

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { Hooks } from "@opencode-ai/plugin";

import { WorktreeGuard } from "../adapters/opencode/worktree-guard.js";

const execFileP = promisify(execFile);

const GUARD_SCRIPT = fileURLToPath(
  new URL("../scripts/require-worktree.sh", import.meta.url),
);

async function git(args: string[]): Promise<void> {
  await execFileP("git", args, { maxBuffer: 1024 * 1024 });
}

describe("OpenCode WorktreeGuard plugin (hook contract + e2e)", () => {
  let sandbox: string;
  let primary: string;
  let linked: string;
  let savedCwd: string;
  // Shared per-test plugin instance — registerAgent and runToolBefore must see
  // the SAME activeAgentForSession map.
  let hooks!: Hooks;

  beforeAll(async () => {
    sandbox = mkdtempSync(join(tmpdir(), "berth-oc-e2e-"));

    // 1. Fresh git repo (primary checkout — `.git` is a directory).
    primary = join(sandbox, "primary");
    mkdirSync(primary, { recursive: true });
    await git(["init", "-q", "-b", "main", primary]);
    await git(["-C", primary, "config", "user.name", "e2e-test"]);
    await git(["-C", primary, "config", "user.email", "e2e@example.com"]);
    await git(["-C", primary, "config", "commit.gpgsign", "false"]);
    writeFileSync(join(primary, "README.md"), "init\n");
    await git(["-C", primary, "add", "-A"]);
    await git(["-C", primary, "commit", "-q", "-m", "init"]);

    // 2. Linked worktree (`.git` is a file → guard allows).
    linked = join(sandbox, "linked");
    await git(["-C", primary, "worktree", "add", "-q", "-b", "feat/x", linked]);
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  beforeEach(async () => {
    savedCwd = process.cwd();
    // Point the adapter at the real guard script and scrub any inherited
    // hatches so each test starts from a clean slate.
    process.env.BERTH_GATE_SCRIPT = GUARD_SCRIPT;
    delete process.env.BERTH_ALLOW_MAIN_WORKTREE;
    delete process.env.BERTH_MASTER_SESSION;
    // Fresh plugin instance per test (clean agent map).
    hooks = await WorktreeGuard({} as never);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    delete process.env.BERTH_GATE_SCRIPT;
    delete process.env.BERTH_ALLOW_MAIN_WORKTREE;
    delete process.env.BERTH_MASTER_SESSION;
  });

  /**
   * Invoke the plugin's chat.message hook to register the active agent for a
   * session. Our implementation only reads `input.agent`, so the output stub is
   * irrelevant (cast through `never`).
   */
  async function registerAgent(
    sessionID: string,
    agent: string,
  ): Promise<void> {
    const fn = hooks["chat.message"];
    if (!fn) throw new Error("chat.message hook not registered");
    await fn({ sessionID, agent }, {} as never);
  }

  /**
   * Invoke the plugin's tool.execute.before hook for `tool` with `args`, under
   * the current cwd/env. Throws if the guard blocks (fail closed).
   */
  async function runToolBefore(
    tool: string,
    args: unknown,
    sessionID = "s1",
  ): Promise<void> {
    const fn = hooks["tool.execute.before"];
    if (!fn) throw new Error("tool.execute.before hook not registered");
    await fn({ tool, sessionID, callID: "c1" }, { args });
  }

  // --- hook registration (the core regression guard for issue #2) -----------

  it("registers a tool.execute.before hook (guard is NOT inert)", () => {
    expect(typeof hooks["tool.execute.before"]).toBe("function");
  });

  it("registers a chat.message hook", () => {
    expect(typeof hooks["chat.message"]).toBe("function");
  });

  // --- block / allow in the primary checkout --------------------------------

  it("blocks an edit in the primary checkout (fail closed)", async () => {
    process.chdir(primary);
    await expect(runToolBefore("edit", {})).rejects.toThrow(/blocked/);
  });

  it("blocks a write in the primary checkout", async () => {
    process.chdir(primary);
    await expect(runToolBefore("write", {})).rejects.toThrow(/blocked/);
  });

  it("blocks a mutating bash command in the primary checkout", async () => {
    process.chdir(primary);
    await expect(
      runToolBefore("bash", { command: "echo hi > f" }),
    ).rejects.toThrow(/blocked/);
  });

  it("allows a whitelisted wt verb in the primary checkout", async () => {
    process.chdir(primary);
    await expect(
      runToolBefore("bash", { command: "wt switch -c feat/x" }),
    ).resolves.toBeUndefined();
  });

  it("does not vet non-guarded tools (read) in the primary checkout", async () => {
    process.chdir(primary);
    await expect(
      runToolBefore("read", { filePath: "README.md" }),
    ).resolves.toBeUndefined();
  });

  it("blocks a command-smuggling bash string in the primary checkout", async () => {
    process.chdir(primary);
    await expect(
      runToolBefore("bash", { command: "wt switch foo; rm -rf /" }),
    ).rejects.toThrow();
  });

  // --- worktree allow -------------------------------------------------------

  it("allows an edit in a linked worktree", async () => {
    process.chdir(linked);
    await expect(runToolBefore("edit", {})).resolves.toBeUndefined();
  });

  it("allows a mutating bash command in a linked worktree", async () => {
    process.chdir(linked);
    await expect(
      runToolBefore("bash", { command: "echo hi > f" }),
    ).resolves.toBeUndefined();
  });

  // --- agent-aware env building --------------------------------------------

  it("master agent: edit in the primary checkout is ALLOWED", async () => {
    process.chdir(primary);
    await registerAgent("master-sess", "master");
    await expect(
      runToolBefore("edit", {}, "master-sess"),
    ).resolves.toBeUndefined();
  });

  it(
    "non-master: a BERTH_MASTER_SESSION hatch in process.env is scrubbed " +
      "(can never satisfy the master hatch by inheritance)",
    async () => {
      process.chdir(primary);
      // A launcher set the master hatch in the ambient env…
      process.env.BERTH_MASTER_SESSION = "1";
      // …but the active agent is NOT master, so buildGuardEnv must scrub it.
      await registerAgent("layer1-sess", "layer1");
      await expect(runToolBefore("edit", {}, "layer1-sess")).rejects.toThrow(
        /blocked/,
      );
    },
  );
});
