#!/usr/bin/env bash
# scripts/spawn-layer1.sh — master (layer 0) spawns a layer-1 subagent in its
# OWN tab + OWN linked worktree. One of the two topology helpers; the
# layer-2 counterpart is scripts/spawn-layer2.sh.
#
# Topology invariant: a new tab ⟺ a new worktree. So a layer-1 spawn always
# creates both. Layer-2 spawns (pane splits) share their parent tab's worktree
# and use scripts/spawn-layer2.sh instead.
#
# Usage:
#   berth layer1 <name> <branch> [runtime]
#   berth layer1 pr-99-review pr-99-review           # runtime defaults to opencode
#   berth layer1 feat-101 feat/101 claude
#
# The spawned pane receives env vars the agent reads to self-identify:
#   BERTH_AGENT_LAYER=1   BERTH_AGENT_BRANCH=<branch>   BERTH_AGENT_WORKTREE=<path>
#
# Requires: running inside herdr (HERDR_WORKSPACE_ID set). The master runs
# with BERTH_ALLOW_MAIN_WORKTREE=1 so it may orchestrate from the primary
# checkout; dispatched agents never set that flag.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: berth layer1 <name> <branch> [runtime]

  name      label for the new tab + pane (e.g. pr-99-review)
  branch    git branch / linked worktree to create (e.g. feat/101)
  runtime   agent executable: opencode (default) | claude | pi

Spawns a layer-1 subagent: a new tab + a new linked worktree in the
current herdr workspace. Only the master (layer 0) should call this —
layer-1 agents spawn layer-2 panes via 'berth layer2'.
EOF
}

[ "$#" -ge 2 ] || { usage; exit 64; }
name="$1"
branch="$2"
runtime="${3:-opencode}"

case "$runtime" in
  opencode|claude|pi) ;;
  *) echo "spawn-layer1: unknown runtime '$runtime' (use opencode|claude|pi)" >&2; exit 64 ;;
esac

if [ -z "${HERDR_WORKSPACE_ID:-}" ]; then
  echo "spawn-layer1: not inside herdr (HERDR_WORKSPACE_ID unset)." >&2
  echo "  These helpers compose herdr tabs/panes with linked worktrees." >&2
  exit 1
fi

# Layer guard: only layer 0 spawns tabs.
case "${BERTH_AGENT_LAYER:-0}" in
  0) ;;
  *) echo "spawn-layer1: BERTH_AGENT_LAYER=${BERTH_AGENT_LAYER} may not spawn layer-1 tabs." >&2
     echo "  Use 'berth layer2' from layer 1; layer 2 cannot spawn further." >&2
     exit 64 ;;
esac

# Defense in depth: subagents must NEVER carry the trunk hatch, even though
# they run in linked worktrees (where the guard's fast path already allows
# their own mutations). Scrub both so a subagent that `cd`s into the primary
# still hits the block. The master (layer 0) is launched with these set via
# `berth master`; without this unset, the spawned runtime would inherit them.
unset BERTH_ALLOW_MAIN_WORKTREE BERTH_MASTER_SESSION

# 1. Create the linked worktree (the guard whitelists `wt switch`).
wt switch -c "$branch"

# 2. Resolve its absolute path (`wt` has no path subcommand; ask git).
worktree_path="$(git worktree list --porcelain |
  awk -v b="refs/heads/$branch" '/^worktree / { wt=$2 } /^branch / { if ($2==b) { print wt; exit } }')"
if [ -z "$worktree_path" ]; then
  echo "spawn-layer1: could not resolve worktree path for branch '$branch'" >&2
  exit 1
fi

# 3. New tab in the current workspace. cwd + BERTH_AGENT_* env land on its root pane.
tab_json="$(herdr tab create \
  --workspace "$HERDR_WORKSPACE_ID" \
  --label "$name" \
  --cwd "$worktree_path" \
  --env "BERTH_AGENT_LAYER=1" \
  --env "BERTH_AGENT_BRANCH=$branch" \
  --env "BERTH_AGENT_WORKTREE=$worktree_path" \
  --no-focus)"
pane_id="$(printf '%s' "$tab_json" |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])')"
tab_id="$(printf '%s' "$tab_json" |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["tab"]["tab_id"])')"
if [ -z "$pane_id" ]; then
  echo "spawn-layer1: herdr tab create returned no root_pane id" >&2
  exit 1
fi

# 4. Launch the runtime in the new pane. This helper SPAWNS only — the caller
#    waits for idle and sends the task (do not pass the task as an argv prompt).
herdr pane rename "$pane_id" "$name"
herdr pane run "$pane_id" "$runtime"

cat <<EOF
✓ layer-1 subagent '$name' spawned.
  tab      : $tab_id
  pane     : $pane_id  (label '$name')
  worktree : $worktree_path
  branch   : $branch
  runtime  : $runtime  (launching)

Wait for idle, then send the task:
  herdr wait agent-status $pane_id --status idle --timeout 60000
  herdr pane run $pane_id "<your task>"
EOF
