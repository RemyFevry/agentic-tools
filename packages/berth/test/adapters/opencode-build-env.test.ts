import { describe, expect, it } from "vitest";

import { __internal } from "../../adapters/opencode/worktree-guard.js";

const { buildGuardEnv } = __internal;

const ALLOW = "BERTH_ALLOW_MAIN_WORKTREE";
const MASTER = "BERTH_MASTER_SESSION";

describe("OpenCode buildGuardEnv (inlined from src/guard/build-env.ts)", () => {
  it("a master session injects BERTH_MASTER_SESSION=1", () => {
    const env = buildGuardEnv({ PATH: "/usr/bin", FOO: "bar" }, true);
    expect(env[MASTER]).toBe("1");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.FOO).toBe("bar");
  });

  it("a non-master session scrubs BOTH master hatches", () => {
    const env = buildGuardEnv(
      {
        PATH: "/usr/bin",
        [ALLOW]: "1",
        [MASTER]: "1",
      },
      false,
    );
    expect(env[ALLOW]).toBeUndefined();
    expect(env[MASTER]).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("preserves unrelated env keys for a master session", () => {
    const env = buildGuardEnv(
      { PATH: "/bin", TERM: "xterm", CUSTOM: "value" },
      true,
    );
    expect(env.CUSTOM).toBe("value");
    expect(env.TERM).toBe("xterm");
    expect(env[MASTER]).toBe("1");
  });

  it("does not inject master status for a non-master session", () => {
    const env = buildGuardEnv({ HOME: "/home/x" }, false);
    expect(env[MASTER]).toBeUndefined();
    expect(env[ALLOW]).toBeUndefined();
    expect(env.HOME).toBe("/home/x");
  });

  it("BERTH_ALLOW_MAIN_WORKTREE set by a launcher does NOT leak to a non-master", () => {
    // A non-master must never satisfy the allow-on-primary hatch by inheritance.
    const env = buildGuardEnv({ [ALLOW]: "1" }, false);
    expect(env[ALLOW]).toBeUndefined();
    expect(env[MASTER]).toBeUndefined();
  });

  it("does not mutate the input environment", () => {
    const input = { [MASTER]: "1", [ALLOW]: "1", KEEP: "yes" };
    buildGuardEnv(input, false);
    expect(input[MASTER]).toBe("1");
    expect(input[ALLOW]).toBe("1");
    expect(input.KEEP).toBe("yes");
  });
});
