// Central naming for the berth toolkit.
//
// Every other name (env vars, command verbs, messages) is derived from the
// constants below so that a rename is a single edit here. The shell guard at
// scripts/require-worktree.sh mirrors the env-var names defined here; keep the
// two in lock-step.

/**
 * Public-facing tool name. Used in user-facing messages.
 */
export const TOOL_NAME = "berth";

/**
 * Prefix for every berth environment variable.
 *
 * Examples: `BERTH_ALLOW_MAIN_WORKTREE`, `BERTH_MASTER_SESSION`.
 */
export const ENV_PREFIX = "BERTH_";

/**
 * The command verb the worktree-manager bootstrap whitelist keys off of.
 *
 * Only this verb (plus a safe subset of its subverbs) is allowed through the
 * guard from a primary checkout, because those verbs are needed to leave the
 * primary for a linked worktree.
 */
export const WORKTREE_MANAGER_CMD = "wt";

/**
 * Env var that, when set to "1", opens the allow-on-primary hatch. Intended
 * for explicit operator override (e.g. a one-shot maintenance command).
 */
export const ALLOW_MAIN_WORKTREE_ENV = `${ENV_PREFIX}ALLOW_MAIN_WORKTREE`;

/**
 * Env var that, when set to "1", marks a process as the master/coordinator
 * session. The master is trusted to run inside the primary checkout.
 */
export const MASTER_SESSION_ENV = `${ENV_PREFIX}MASTER_SESSION`;
