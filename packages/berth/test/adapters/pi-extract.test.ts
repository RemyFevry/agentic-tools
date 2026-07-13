import { describe, expect, it } from "vitest";

import { extractPiCommand } from "../../adapters/pi/worktree-guard.js";

describe("extractPiCommand (Pi tool_call multi-shape)", () => {
  it("extracts from event.input.command", () => {
    expect(extractPiCommand({ input: { command: "rm -rf build" } })).toBe(
      "rm -rf build",
    );
  });

  it("falls back to event.input.args", () => {
    expect(extractPiCommand({ input: { args: "git status" } })).toBe(
      "git status",
    );
  });

  it("falls back to event.args.command", () => {
    expect(extractPiCommand({ args: { command: "ls -la" } })).toBe("ls -la");
  });

  it("falls back to event.command", () => {
    expect(extractPiCommand({ command: "pwd" })).toBe("pwd");
  });

  it("respects the fallback order: input.command beats input.args", () => {
    expect(
      extractPiCommand({ input: { command: "first", args: "second" } }),
    ).toBe("first");
  });

  it("respects the fallback order: input.args beats args.command", () => {
    expect(
      extractPiCommand({
        input: { args: "from-args" },
        args: { command: "later" },
      }),
    ).toBe("from-args");
  });

  it("returns '' when every candidate is empty", () => {
    expect(
      extractPiCommand({
        input: { command: "" },
        args: { command: "" },
        command: "",
      }),
    ).toBe("");
    expect(extractPiCommand({})).toBe("");
  });

  it("returns '' for null / undefined input", () => {
    expect(extractPiCommand(null)).toBe("");
    expect(extractPiCommand(undefined)).toBe("");
  });

  it("ignores non-string candidates and keeps walking the fallback chain", () => {
    expect(
      extractPiCommand({ input: { command: 42 }, command: "real-command" }),
    ).toBe("real-command");
  });

  it("ignores an empty-string candidate and keeps walking the fallback chain", () => {
    expect(extractPiCommand({ input: { command: "" }, command: "later" })).toBe(
      "later",
    );
  });
});
