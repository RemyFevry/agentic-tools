#!/usr/bin/env bash
# scripts/feat.sh — open a berth Change as a linked worktree, optionally
# anchor a herdr Workspace to it.
#
# Usage:
#   berth feat <branch>            # → explicit branch
#   berth feat 46                  # → branch feat/46
#   berth feat fix/<short>         # → accept "fix/foo" or "feat/foo" forms
#
# This is the open-side of the canonical berth Change loop:
#   berth feat <branch>  → opens the Change in a linked worktree
#   berth ship           → closes it (see scripts/ship.sh)
#
# herdr is non-mandatory. The Workspace creation step runs only if
# `herdr` is on PATH; otherwise `wt switch` is the complete workflow.
# herdr failures are logged and ignored — the canonical worktree
# operation must not fail because of an optional herdr step.
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: berth feat <branch>" >&2
  echo "  example: berth feat feat/46" >&2
  echo "           berth feat fix/state-sync" >&2
  echo "           berth feat 46             # → feat/46" >&2
  exit 64
fi

branch="feat/${1#feat/}"   # accept "46" or "fix/foo" or "feat/foo"

# Capture the path BEFORE delegating to wt, since the subsequent
# subprocess may or may not be inside the new worktree depending on
# whether `wt config shell install` integration is active.
worktree_path="$(pwd)"
herdr_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"

# Always: open the linked worktree. This is the canonical berth primitive
# (see scripts/require-worktree.sh).
wt switch -c "$branch"

# Conditional: anchor a herdr Workspace to this worktree. berth does not own
# herdr; the dev who uses herdr gets a sidebar-friendly slot per Change.
# Non-fatal: a herdr failure must not break the worktree side.
if command -v herdr >/dev/null 2>&1; then
  target="$herdr_root"
  [ -z "$target" ] && target="$worktree_path"
  if ! herdr workspace create --cwd "$target" --label "$branch" --no-focus; then
    echo "warning: herdr workspace create failed; the worktree is created, but the herdr Workspace is not." >&2
    echo "         Re-run \`herdr workspace create --cwd '$target' --label '$branch'\` later." >&2
  fi
fi
