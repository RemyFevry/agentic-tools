#!/usr/bin/env bash
# scripts/master.sh — canonical launcher for the berth master (layer 0) session.
#
# The master orchestrator runs in the PRIMARY checkout so it can drive
# `herdr` / `wt` / `gh` / `git`. The worktree guard
# (scripts/require-worktree.sh) blocks every mutating bash in the primary
# unless BERTH_ALLOW_MAIN_WORKTREE=1 is set. This launcher is the ONE
# canonical place a berth-shipped tool sets that hatch.
#
# Subagents are NEVER launched this way — they live in linked worktrees
# (`berth layer1` / `berth layer2`) and so never inherit the hatch. The env
# var is set in THIS process only; it is never written into the repo or any
# shell config. The spawn scripts additionally `unset` it (defense in depth).
#
# Usage:
#   berth master                 # launches opencode (default) in the primary
#   berth master opencode        #   … explicit
#   berth master claude          # launches claude code
#   berth master pi              # launches pi
#   berth master /path/to/rt     # launches an explicit command
#
# Dry run (used by tests and for inspection — prints the resolved runtime and
# the hatch without launching anything):
#   BERTH_MASTER_DRY_RUN=1 berth master
set -euo pipefail

RUNTIME="${1:-opencode}"

# The hatch. The ONE place a berth-shipped tool sets BERTH_ALLOW_MAIN_WORKTREE.
# A human invokes this launcher explicitly to start a master session; an agent
# never does (agents live in worktrees). The guard honors it as the escape
# hatch and lets the master's bash through.
export BERTH_ALLOW_MAIN_WORKTREE=1

# Detect whether the current cwd is a linked worktree (.git is a file) vs the
# primary (.git is a directory). The master belongs in the primary; warn
# loudly (but still proceed) if launched from a worktree.
top_level="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -n "$top_level" && -f "$top_level/.git" ]]; then
  printf '\033[1;33m[master]\033[0m warning: you are inside a linked worktree (%s).\n' "$top_level" >&2
  printf '\033[1;33m[master]\033[0m The master orchestrator normally runs in the PRIMARY checkout.\n' >&2
  printf '\033[1;33m[master]\033[0m Proceeding anyway (BERTH_ALLOW_MAIN_WORKTREE is harmless in a worktree).\n' >&2
fi

if [[ "${BERTH_MASTER_DRY_RUN:-0}" == "1" ]]; then
  printf 'berth master launcher (dry run)\n'
  printf '  runtime:                  %s\n' "$RUNTIME"
  printf '  cwd:                      %s\n' "${top_level:-<not a git repo>}"
  printf '  BERTH_ALLOW_MAIN_WORKTREE: %s\n' "${BERTH_ALLOW_MAIN_WORKTREE}"
  printf '  (would exec the runtime with the hatch above)\n'
  exit 0
fi

# Map friendly runtime names to their commands; anything else is treated as a
# literal command/path so `berth master /usr/local/bin/foo` works.
case "$RUNTIME" in
  opencode) cmd=(opencode);;
  claude)   cmd=(claude);;
  pi)       cmd=(pi);;
  --)       cmd=(opencode);;
  *)        cmd=("$RUNTIME");;
esac

printf '\033[1;34m[master]\033[0m launching %s in the primary with the worktree hatch set\n' "${cmd[*]}"
exec "${cmd[@]}"
