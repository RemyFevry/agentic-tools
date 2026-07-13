#!/usr/bin/env bash
# scripts/ship.sh — close a berth Change: merge the linked worktree via
# `wt merge main`, optionally close the matching herdr Workspace.
#
# Usage:
#   berth ship
#
# This is the close-side counterpart to scripts/feat.sh.
#
# herdr is non-mandatory. The Workspace close step runs only if herdr is on
# PATH AND a matching Workspace (label == captured branch) is found.
# herdr failures are logged and ignored — a successful `wt merge main` must
# not be reported as failed because of an optional herdr step.
set -euo pipefail

# Always: merge the linked worktree through wt's [pre-merge] gates.
# `wt merge main` runs the typecheck/lint/test sequence defined in .config/wt.toml.
wt merge main

# Conditional: close the herdr Workspace whose label matches the just-merged
# branch. We capture the branch before the merge because post-merge cwd /
# branch state can be unreliable once the worktree is removed.
if command -v herdr >/dev/null 2>&1; then
  branch="$(git branch --show-current)"

  # Skip in the unlikely case we ran `wt merge` from main itself.
  if [ "$branch" != "main" ]; then
    ws_id="$(HERDR_BRANCH="$branch" herdr workspace list --json 2>/dev/null \
      | HERDR_BRANCH="$branch" python3 -c '
import sys, json, os
target = os.environ.get("HERDR_BRANCH", "")
for w in json.load(sys.stdin).get("result", {}).get("workspaces", []):
    if w.get("label") == target:
        print(w.get("workspace_id", ""))
        break
' 2>/dev/null || true)"

    if [ -n "$ws_id" ]; then
      if ! herdr workspace close "$ws_id"; then
        echo "warning: herdr workspace close failed for workspace $ws_id; wt merge main succeeded." >&2
        echo "         Manually run: herdr workspace close $ws_id" >&2
      fi
    fi
  fi
fi
