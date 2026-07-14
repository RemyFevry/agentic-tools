//
// E2E for the Pi trunk-guard adapter.
//
// The adapter exports a factory `worktreeGuard(pi)` that registers a
// `tool_call` handler on the Pi plugin API. This test feeds the factory a
// fake `pi` object, captures the registered handler, and invokes it with
// real Pi event shapes (`event.toolName`, `event.input`) against live git
// repos. This catches the exact bug from issue #4 — the handler reading
// `event.tool` (undefined) instead of `event.toolName` and silently
// never activating.
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

import worktreeGuard, {
  type PiToolCallEvent,
  type PiToolCallResult,
} from "../adapters/pi/worktree-guard.js";

const execFileP = promisify(execFile);

const GUARD_SCRIPT = fileURLToPath(
  new URL("../scripts/require-worktree.sh", import.meta.url),
);

async function git(args: string[]): Promise<void> {
  await execFileP("git", args, { maxBuffer: 1024 * 1024 });
}

/**
 * Capture the handler registered by the adapter so it can be invoked
 * directly with controlled event shapes.
 */
function captureHandler(): (
  e: PiToolCallEvent,
) => PiToolCallResult | undefined {
  let captured:
    ((e: PiToolCallEvent) => PiToolCallResult | undefined | void) | undefined;
  const fakePi: {
    on(
      event: "tool_call",
      handler: (e: PiToolCallEvent) => PiToolCallResult | undefined | void,
    ): void;
  } = {
    on(_event, handler) {
      captured = handler;
    },
  };
  worktreeGuard(fakePi);
  if (!captured) throw new Error("tool_call handler was not registered");
  return captured as (e: PiToolCallEvent) => PiToolCallResult | undefined;
}

describe("Pi adapter (worktreeGuard handler contract + e2e)", () => {
  let sandbox: string;
  let primary: string;
  let linked: string;
  let savedCwd: string;
  let handler: ReturnType<typeof captureHandler>;

  beforeAll(async () => {
    sandbox = mkdtempSync(join(tmpdir(), "berth-pi-e2e-"));

    primary = join(sandbox, "primary");
    mkdirSync(primary, { recursive: true });
    await git(["init", "-q", "-b", "main", primary]);
    await git(["-C", primary, "config", "user.name", "e2e-test"]);
    await git(["-C", primary, "config", "user.email", "e2e@example.com"]);
    await git(["-C", primary, "config", "commit.gpgsign", "false"]);
    writeFileSync(join(primary, "README.md"), "init\n");
    await git(["-C", primary, "add", "-A"]);
    await git(["-C", primary, "commit", "-q", "-m", "init"]);

    linked = join(sandbox, "linked");
    await git(["-C", primary, "worktree", "add", "-q", "-b", "feat/x", linked]);
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  beforeEach(() => {
    savedCwd = process.cwd();
    process.env.BERTH_GATE_SCRIPT = GUARD_SCRIPT;
    delete process.env.BERTH_ALLOW_MAIN_WORKTREE;
    delete process.env.BERTH_MASTER_SESSION;
    handler = captureHandler();
  });

  afterEach(() => {
    process.chdir(savedCwd);
    delete process.env.BERTH_GATE_SCRIPT;
    delete process.env.BERTH_ALLOW_MAIN_WORKTREE;
    delete process.env.BERTH_MASTER_SESSION;
  });

  // --- handler registration (regression guard for issue #4) ----------------

  it("registers a tool_call handler (guard is NOT inert)", () => {
    expect(typeof handler).toBe("function");
  });

  // --- the core regression: event.toolName, not event.tool -----------------

  it("reads event.toolName and blocks a write in the primary checkout", () => {
    process.chdir(primary);
    const result = handler({
      toolName: "write",
      input: { path: "/some/file", content: "x" },
    });
    expect(result?.block).toBe(true);
  });

  it("reads event.toolName and blocks a bash mutation in the primary checkout", () => {
    process.chdir(primary);
    const result = handler({
      toolName: "bash",
      input: { command: "echo hi > f" },
    });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("blocked");
  });

  it("reads event.toolName and blocks an edit in the primary checkout", () => {
    process.chdir(primary);
    const result = handler({
      toolName: "edit",
      input: { path: "/some/file", edits: [] },
    });
    expect(result?.block).toBe(true);
  });

  // --- the old field name (event.tool) must NOT activate the guard ----------

  it("ignores an event with only event.tool (undefined toolName) — does not crash", () => {
    process.chdir(primary);
    // Pi never sets event.tool — if it did, the handler must not throw.
    const result = handler({
      input: { command: "echo hi > f" },
    });
    // toolName is undefined → handler early-returns → no block (tool not guarded).
    expect(result).toBeUndefined();
  });

  // --- allow cases ----------------------------------------------------------

  it("allows a whitelisted wt verb in the primary checkout", () => {
    process.chdir(primary);
    const result = handler({
      toolName: "bash",
      input: { command: "wt switch -c feat/x" },
    });
    expect(result).toBeUndefined();
  });

  it("does not vet non-guarded tools (read) in the primary checkout", () => {
    process.chdir(primary);
    const result = handler({
      toolName: "read",
      input: { path: "README.md" },
    });
    expect(result).toBeUndefined();
  });

  it("allows a write in a linked worktree", () => {
    process.chdir(linked);
    const result = handler({
      toolName: "write",
      input: { path: "/some/file", content: "x" },
    });
    expect(result).toBeUndefined();
  });

  it("allows a bash mutation in a linked worktree", () => {
    process.chdir(linked);
    const result = handler({
      toolName: "bash",
      input: { command: "echo hi > f" },
    });
    expect(result).toBeUndefined();
  });

  it("blocks a command-smuggling bash string in the primary checkout", () => {
    process.chdir(primary);
    const result = handler({
      toolName: "bash",
      input: { command: "wt switch foo; rm -rf /" },
    });
    expect(result?.block).toBe(true);
  });
});
