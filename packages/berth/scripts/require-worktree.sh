#!/usr/bin/env bash
#
# berth trunk guard — the canonical source of truth.
#
# Decides whether the caller may run a command that would mutate the primary
# git checkout's working tree. Exit 0 = allow, exit 2 = block. Unexpected
# failure is fail-closed (block).
#
# Invocation:
#   require-worktree.sh "<command the caller is about to run>"
#
#   $1 is the full command string the caller is about to execute. Callers that
#   only read/edit files pass "" (empty), which never matches the bootstrap
#   whitelist and falls straight through to the worktree check.
#
# Decision order:
#   1. BERTH_ALLOW_MAIN_WORKTREE=1            -> allow (explicit override)
#   2. BERTH_MASTER_SESSION=1                 -> allow (master/coordinator)
#   3. $1 matches the bootstrap whitelist     -> allow (read-only wt verbs)
#   4. not a git repo                         -> allow (nothing to protect)
#   5. .git is a file (linked worktree)       -> allow
#   6. .git is a directory (primary checkout) -> BLOCK
#
# The env-var names below mirror src/constants.ts exactly. They are hard-coded
# here because the guard runs before any TypeScript is compiled or imported;
# keep the two in lock-step.

set -uo pipefail

# --- naming (mirror of src/constants.ts) -------------------------------------
TOOL_NAME="berth"
ENV_PREFIX="BERTH_"
WORKTREE_MANAGER_CMD="wt"
ALLOW_MAIN_WORKTREE_VAR="${ENV_PREFIX}ALLOW_MAIN_WORKTREE"
MASTER_SESSION_VAR="${ENV_PREFIX}MASTER_SESSION"

# Bootstrap whitelist: read-only worktree-manager verbs only.
# Deliberately excludes the `merge` and `remove` verbs, and restricts every
# argument to a strict alphabet so that shell metacharacters
# (`;`, `&&`, `|`, backticks, `$()`, redirections) can never be smuggled in.
BOOTSTRAP_ALLOW_RE='^wt (switch|list|path|which|config|diff|log|step)( [a-zA-Z0-9._=/@:+-]+){0,16}$'

block() {
    printf '%s: this command is blocked in the primary checkout.\n' "$TOOL_NAME" >&2
    printf 'The primary worktree is protected from direct edits.\n' >&2
    printf 'Move this work into a linked worktree first:\n' >&2
    printf '  %s switch -c <branch>\n' "$WORKTREE_MANAGER_CMD" >&2
    exit 2
}

# 1. Explicit operator override hatch.
if [[ "${!ALLOW_MAIN_WORKTREE_VAR:-}" == "1" ]]; then
    exit 0
fi

# 2. Master/coordinator session hatch.
if [[ "${!MASTER_SESSION_VAR:-}" == "1" ]]; then
    exit 0
fi

# 3. Bootstrap whitelist. An empty command ("") never matches, so edit/write
#    callers fall through to the worktree check below.
cmd="${1:-}"
if [[ "$cmd" =~ $BOOTSTRAP_ALLOW_RE ]]; then
    exit 0
fi

# 4. Not a git repo -> nothing to protect. (Suppress git's stderr; failure is
#    the expected, handled outcome here, not an error.)
toplevel="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$toplevel" ]]; then
    exit 0
fi

# 5. Linked worktree: `.git` is a file that points at the real gitdir.
if [[ -f "$toplevel/.git" ]]; then
    exit 0
fi

# 6. Primary checkout: `.git` is a directory.
if [[ -d "$toplevel/.git" ]]; then
    block
fi

# Unexpected layout (e.g. `.git` missing entirely) -> fail-closed.
block
