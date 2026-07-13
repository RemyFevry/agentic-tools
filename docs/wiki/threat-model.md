---
veye: true
title: berth threat model
type: concept
covers:
  - packages/berth/scripts/require-worktree.sh
  - packages/berth/src/guard/build-env.ts
  - packages/berth/scripts/master.sh
  - packages/berth/scripts/spawn-layer1.sh
depends_on:
  - docs/wiki/architecture.md
  - docs/wiki/glossary.md
last_verified: 2026-07-13
---

## Scope

berth protects a single git repository's **primary checkout** from direct
mutation by autonomous agents. It does not protect:

- the working trees of linked worktrees (those _are_ the work surface),
- other repositories the agent may clone,
- the host system beyond what a normal user can do,
- the agent's prompt or tool registry (those are runtime concerns).

berth is a **last-line-of-defense** against an agent deciding to mutate the
trunk. It is not a substitute for runtime permissions, prompt hardening, or
human review.

## What the guard guarantees

Given the decision order in `packages/berth/scripts/require-worktree.sh`, berth guarantees:

1. **No bash the agent runs in the primary checkout mutates the working
   tree.** The guard sees the command before execution (via PreToolUse or
   equivalent) and blocks it. The agent cannot bypass this by adding flags,
   quoting tricks, or command substitution — the guard runs first, with the
   **full command string** in hand.
2. **No file edit the agent performs in the primary checkout mutates the
   working tree.** Edit and Write tools have no command string; the guard
   receives an empty string and falls straight through to the worktree check,
   which blocks in the primary.
3. **The primary hatch is set by exactly one place.** The master launcher is
   the only berth-shipped tool that exports it. Spawn scripts explicitly
   `unset BERTH_ALLOW_MAIN_WORKTREE BERTH_MASTER_SESSION` before exec'ing
   the runtime.
4. **A non-master agent cannot satisfy a master hatch by inheritance.** Even
   if the agent `cd`s into the primary checkout, the env vars are scrubbed.
   The OpenCode adapter enforces this via `buildGuardEnv`; the other
   adapters rely on the spawn scripts having unset the vars.
5. **Unexpected failure is fail-closed.** If `bash` is missing, the guard
   script is missing, `git` errors, or any other unexpected state, the
   adapter exits 2 (block). Silent fall-through would defeat the guarantee.

## Threat model — what the guard blocks

| Threat                                                                 | Vector                  | Mitigation                                                                                                                                                                                |
| ---------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent edits a tracked file directly in the primary                     | Edit or Write tool      | Guard sees empty string; `.git` is a directory → block                                                                                                                                    |
| Agent runs `git commit`, `git push`, or `rm` in the primary            | Bash tool               | Guard sees the command; primary → block                                                                                                                                                   |
| Agent chains `cd ../..` followed by `rm -rf .`                         | Bash tool               | The guard is invoked per command by the runtime; the `cd` is its own command (allowed or blocked on its own) and the removal is a separate command, evaluated separately                  |
| Agent smuggles shell metacharacters into a worktree-manager invocation | Bash tool               | Bootstrap whitelist regex restricts arguments to a strict alphabet; chained commands with shell metacharacters are rejected                                                               |
| Agent inherits `BERTH_ALLOW_MAIN_WORKTREE` from a parent shell         | env-injection attack    | Spawn scripts `unset` it before exec; OpenCode adapter scrubs it via `buildGuardEnv`                                                                                                      |
| Agent edits the guard script itself to always return 0                 | file mutation           | berth is itself committed to the repo; mutating the guard is a tracked change that hits the same guard (primary) → blocked. Workaround: the operator can set the hatch and patch manually |
| Agent bypasses the adapter entirely (calls tools directly)             | runtime-only mitigation | berth does not defend against this. Runtime permissions + sandboxing is the answer here                                                                                                   |

## Out of scope (deliberately)

berth does not attempt to defend against:

- **Prompt injection that causes the agent to _want_ to mutate the primary.**
  berth blocks the _action_, not the intent.
- **Side-channel exfiltration** through tools that the agent runs in linked
  worktrees. Linked worktrees are the work surface; the agent can read any
  file in them, including untracked files. This is by design.
- **Mutations to other repositories.** berth scopes itself to one repo at a
  time.
- **A compromised `wt` binary.** If the worktree manager itself is malicious,
  the bootstrap whitelist cannot save you. Pin your `wt` and audit it.
- **Race conditions across multiple primaries.** berth assumes one primary
  per repo.

## Defense in depth

berth is meant to be one layer of a stack:

1. **Runtime permissions** (OpenCode denies edit and write, Claude Code uses
   a tools allow-list, Pi prompt). The first line of defense.
2. **berth trunk guard** (this). The second line — catches anything
   permissions let through.
3. **CODEOWNERS + branch protection.** The third line — humans review
   anything that gets pushed.
4. **herdr / terminal multiplexing.** If you can see every pane and every
   command, you can spot trouble before it lands.

Removing any one layer weakens the system. berth's job is to be the layer
that catches everything the layer above missed.

## The escape hatches — and why they exist

`BERTH_ALLOW_MAIN_WORKTREE=1` is an explicit override. It is set by the
master launcher and by operator intervention. It exists for the legitimate
cases where an agent _should_ be allowed to mutate the primary:

- The master orchestrator runs in the primary on purpose — that's its job.
- An operator may need to run a one-shot maintenance command without first
  creating a worktree.

The escape hatch is **the single largest threat surface in berth** by design.
An attacker who can set env vars in the agent's process has already won; the
guard cannot defend against that. The OpenCode adapter mitigates this by
scrubbing both hatches from the env it builds for non-master agents.

## Operator checklist

Before installing berth:

- Pin your `wt` binary; audit it once.
- Ensure `BERTH_ALLOW_MAIN_WORKTREE` is **not** in your agent runtime's
  default environment.
- Ensure `BERTH_MASTER_SESSION` is **not** in your agent runtime's default
  environment.

After installing berth, verify:

```sh
# Blocks in the primary:
./scripts/require-worktree.sh "rm -rf build"
# → exit 2

# Allows in a linked worktree:
./scripts/require-worktree.sh "rm -rf build"
# → exit 0

# Non-master cannot satisfy master hatch:
env -u BERTH_MASTER_SESSION bash scripts/require-worktree.sh "rm -rf build"
# → exit 2 in the primary
```

## Related

- [Architecture](architecture.md)
- [Glossary](glossary.md)
