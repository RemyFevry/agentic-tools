import { describe, expect, it } from "vitest";

import { extractClaudeCommand } from "../../adapters/claude/worktree-guard.mjs";

describe("extractClaudeCommand (Claude Code PreToolUse)", () => {
  it("extracts the command from a Bash event", () => {
    expect(
      extractClaudeCommand({
        tool_name: "Bash",
        tool_input: { command: "rm -rf build" },
      }),
    ).toBe("rm -rf build");
  });

  it("returns '' for Edit (no command)", () => {
    expect(
      extractClaudeCommand({
        tool_name: "Edit",
        tool_input: { file_path: "/x", old_string: "a", new_string: "b" },
      }),
    ).toBe("");
  });

  it("returns '' for Write (no command)", () => {
    expect(
      extractClaudeCommand({
        tool_name: "Write",
        tool_input: { file_path: "/y" },
      }),
    ).toBe("");
  });

  it("returns '' when tool_input.command is missing on a Bash event", () => {
    expect(extractClaudeCommand({ tool_name: "Bash", tool_input: {} })).toBe(
      "",
    );
  });

  it("returns '' when tool_input.command is not a string", () => {
    expect(
      extractClaudeCommand({ tool_name: "Bash", tool_input: { command: 42 } }),
    ).toBe("");
    expect(
      extractClaudeCommand({
        tool_name: "Bash",
        tool_input: { command: null },
      }),
    ).toBe("");
  });

  it("returns '' when tool_input itself is missing", () => {
    expect(extractClaudeCommand({ tool_name: "Bash" })).toBe("");
  });

  it("returns '' when fields are missing entirely", () => {
    expect(extractClaudeCommand({})).toBe("");
  });

  it("returns '' for null / undefined / non-object input", () => {
    expect(extractClaudeCommand(null)).toBe("");
    expect(extractClaudeCommand(undefined)).toBe("");
    expect(extractClaudeCommand("not-an-event")).toBe("");
    expect(extractClaudeCommand(123)).toBe("");
  });

  it("preserves an empty-string command verbatim", () => {
    // An empty command never matches the bootstrap whitelist and falls through
    // to the worktree check, so it must be passed through as "".
    expect(
      extractClaudeCommand({ tool_name: "Bash", tool_input: { command: "" } }),
    ).toBe("");
  });
});
