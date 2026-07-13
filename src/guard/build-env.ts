import { ALLOW_MAIN_WORKTREE_ENV, MASTER_SESSION_ENV } from "../constants.js";

/**
 * A process environment: a map of variable names to string-ish values. Mirrors
 * {@link NodeJS.ProcessEnv}, kept loose so callers can pass `process.env`
 * directly.
 */
export type Env = Record<string, string | undefined>;

/**
 * Build the environment a guarded child process should run with.
 *
 * Decision rules:
 *
 * - **Master session** (`isMaster === true`): inherit the parent environment
 *   AND assert master status by setting
 *   {@link MASTER_SESSION_ENV}`= "1"`. The master is trusted on the primary
 *   checkout.
 * - **Non-master session** (`isMaster === false`): inherit the parent
 *   environment BUT delete BOTH master hatches
 *   ({@link ALLOW_MAIN_WORKTREE_ENV} and {@link MASTER_SESSION_ENV}). A
 *   non-master must never satisfy either hatch merely by inheritance.
 *
 * Unrelated keys are always preserved.
 */
export function buildGuardEnv(processEnv: Env, isMaster: boolean): Env {
  const env: Env = { ...processEnv };
  if (isMaster) {
    env[MASTER_SESSION_ENV] = "1";
  } else {
    delete env[ALLOW_MAIN_WORKTREE_ENV];
    delete env[MASTER_SESSION_ENV];
  }
  return env;
}
