import { describe, expect, it } from "vitest";

import { extractOpenCodeCommand } from "../../adapters/opencode/worktree-guard.js";

describe("extractOpenCodeCommand (output.args shape)", () => {
  it("extracts from args.command", () => {
    expect(extractOpenCodeCommand({ command: "rm -rf build" })).toBe(
      "rm -rf build",
    );
  });

  it("returns '' when command is absent (edit/write tools)", () => {
    expect(extractOpenCodeCommand({ filePath: "/some/file" })).toBe("");
  });

  it("returns '' for an empty args object", () => {
    expect(extractOpenCodeCommand({})).toBe("");
  });

  it("returns '' for null / undefined", () => {
    expect(extractOpenCodeCommand(null)).toBe("");
    expect(extractOpenCodeCommand(undefined)).toBe("");
  });

  it("ignores a non-string command", () => {
    expect(extractOpenCodeCommand({ command: 42 })).toBe("");
    expect(extractOpenCodeCommand({ command: null })).toBe("");
    expect(extractOpenCodeCommand({ command: { nested: true } })).toBe("");
  });
});
