import { describe, expect, it } from "vitest";

import {
  ALLOW_MAIN_WORKTREE_ENV,
  MASTER_SESSION_ENV,
} from "../src/constants.js";
import { buildGuardEnv } from "../src/guard/build-env.js";

describe("buildGuardEnv", () => {
  it("injects BERTH_MASTER_SESSION=1 for a master session", () => {
    const env = buildGuardEnv({ PATH: "/usr/bin", FOO: "bar" }, true);
    expect(env[MASTER_SESSION_ENV]).toBe("1");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.FOO).toBe("bar");
  });

  it("scrubs both master hatches for a non-master session", () => {
    const env = buildGuardEnv(
      {
        PATH: "/usr/bin",
        [ALLOW_MAIN_WORKTREE_ENV]: "1",
        [MASTER_SESSION_ENV]: "1",
      },
      false,
    );
    expect(env[ALLOW_MAIN_WORKTREE_ENV]).toBeUndefined();
    expect(env[MASTER_SESSION_ENV]).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("does not inject master status for a non-master session", () => {
    const env = buildGuardEnv({ HOME: "/home/x" }, false);
    expect(env[MASTER_SESSION_ENV]).toBeUndefined();
    expect(env[ALLOW_MAIN_WORKTREE_ENV]).toBeUndefined();
    expect(env.HOME).toBe("/home/x");
  });

  it("preserves unrelated keys for a master session", () => {
    const env = buildGuardEnv(
      { PATH: "/bin", TERM: "xterm", CUSTOM: "value" },
      true,
    );
    expect(env.CUSTOM).toBe("value");
    expect(env.TERM).toBe("xterm");
  });

  it("does not mutate the input environment", () => {
    const input = { [MASTER_SESSION_ENV]: "1", KEEP: "yes" };
    buildGuardEnv(input, false);
    expect(input[MASTER_SESSION_ENV]).toBe("1");
    expect(input.KEEP).toBe("yes");
  });
});
