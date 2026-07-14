<!-- veye:freshness-gate-section -->

## Freshness gate

This repository is instrumented with [Veye](https://github.com/RemyFevry/fil),
a doc-freshness engine. Every markdown file under `docs/wiki/` with a
`veye: true` frontmatter block is tracked for freshness.

**How freshness works.** Each page declares the code it covers (`covers:`),
the dependencies it has on other pages (`depends_on:`), and the last time a
human verified its contents (`last_verified:`). On every push that touches
covered code, Veye re-computes a 0–100 composite score per page and commits
`.veye/freshness.json`.

**The freshness gate.** On every pull request, Veye checks each covering page
for the PR's diff. If you changed covered code, you must also touch the body
of the covering doc — frontmatter-only changes do not count. Pages below their
threshold fail the gate (in blocking mode) or post an advisory comment (in
advisory mode, the default).

**Resolving a gate failure.** You have four options:

1. **Update the doc.** Read the page, revise the content to reflect the code
   change, and commit. Any body edit advances `last_verified` and passes the
   gate for that page.
2. **Narrow coverage.** If the page's `covers:` is too greedy, tighten the
   globs so the changed code is no longer in scope.
3. **Acknowledge debt.** Set `acknowledged_debt: <YYYY-MM-DD>` in the page's
   frontmatter. This is a maintainer-approved expiration date — the gate
   suppresses failures for that page until the date passes. PR review is the
   approval surface.
4. **Hotfix bypass.** Apply the `veye:docs-only` label to the PR. This skips
   the gate entirely for that PR. Use sparingly — it accrues acknowledged debt
   with faster decay.

**Where to look.** The committed freshness map is `.veye/freshness.json`.
The generated dashboard (`docs/wiki.dist/_dashboard.md`) renders on the
published site. On PRs, the gate comment surfaces every failing page with its
score, threshold, and the KPI that triggered it.
