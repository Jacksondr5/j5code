---
title: "PR pane"
kind: definition
---

# PR pane

## Problem

When a fleet of agents works many pull requests at once, the person cannot tell at a glance who has reviewed what, whether a PR can be merged, whether the agents are still working it, or what they decided in response to reviews. Asking an agent means getting a recollection instead of a fact ([problems](../problems.md): PR management is difficult; status is read, never asked). The prior-art dashboard solved this for one workflow and taught two lessons the product keeps: every fact must be measured, and a plausible fake is worse than a visible gap.

## Definition

The **PR pane** shows the pull requests the fleet is working on, as measured facts, with one action: send a message to an agent about a PR.

A PR appears on the pane when it is **associated with an agent**. The platform infers the association from what it already knows — an open PR whose head branch matches a branch an agent pushed from its worktree — and shows that provenance as inferred; the person can associate or dissociate a PR by hand, shown as asserted. Inference is conservative: an ambiguous match shows the PR unassociated rather than guessing, because a wrong association would render one agent's liveness against another's PR. Pull requests belong to a Squadron through the agents working them.

Every fact on the pane is **measured from the forge by the platform, on a cadence, never recalled by an agent**: state, draft, title, author, branches, head commit, mergeability, review decision, the check rollup with failed check names, unresolved review threads, timestamps, and when it was last measured. The pane **never guesses**: an unknown mergeability shows as "?", a PR not yet measured shows as measuring, and an unreachable forge leaves the last-known facts in place with a staleness clock — never an outage rendered as "everything is fine" or "everything is dead." Measured facts are rebuildable from scratch; a person's associations are not lost when they are rebuilt.

The pane is **read-only toward the forge**. It never merges, comments, closes or re-runs anything. Its one action opens the ordinary message composer to an associated agent, prefilled with the PR, its head commit, and a compact snapshot of the measured state, for the person to edit and send through the same path as any other message — so the pane can never hold state the agents do not know about.

Rows are ordered attention-first — needs something (failing checks, conflicts, changes requested), then waiting (checks running, review pending), then green — and **stable within a group**: rows update in place and never move under the cursor. Closed and merged PRs stay briefly, then leave. Like every fleet surface, the pane merges every connected environment and names each PR's environment.

The pane carries **no workflow methodology**. The prior-art dashboard computed readiness gates for one three-agent workflow; those do not ship. Whether a PR is "ready" by some workflow's rules is the workflow's content; the generic successor — named status checks any workflow can define, rendered with outcome and staleness — is a separate primitive, later. GitHub is the only forge today, behind a thin seam so a second one can follow.

The pane is **not** a place to act on pull requests, **not** a readiness or gating system, and **not** the fleet-attention view; it is one pane beside the Fleet page and the inbox, designed so siblings can join it.

## Acceptance criteria

### Association

1. A PR opened from a branch an agent pushed from its worktree appears on the pane within one measurement cycle, associated to that agent with provenance shown as inferred.
2. A PR with no inferable agent does not appear until a person associates it; that association shows provenance as asserted; either kind can be removed.
3. When inference is ambiguous, the PR shows as unassociated.

### Measurement

4. Check completions are reflected within one measurement cycle even when the PR's own updated timestamp did not change.
5. An unknown mergeability renders as "?" and never as mergeable; a PR not yet measured renders as measuring.
6. When the forge is unreachable, every row keeps its last-known facts with a visible staleness clock, nothing renders green by default, and measurement resumes without a restart when the forge returns.
7. Wiping the measured facts and re-measuring loses no person-asserted association.

### The pane

8. Rows order attention-first and stay in stable order within a group; a row updates in place and never moves under the cursor.
9. Twenty or more PRs render with fixed-height rows and no continuous repaint.
10. Each row names its environment, and PRs from every connected environment appear on one pane.
11. Closed and merged PRs remain for a bounded time, then leave.

### The action

12. "Message agent" opens the composer to the associated agent, prefilled with the PR, its head commit and the measured state, and sends through the ordinary agent-message path; the pane performs no write to the forge of any kind.
13. No readiness gate or workflow rule is computed or shown.

## Scenarios

- **A PR appears.** The Builder in Billing Migration pushes `billing/schema-v2` and opens a PR; within a cycle the pane shows it, associated to the Builder as inferred, with checks running. (AC1)
- **Checks finish quietly.** CI completes without touching the PR; the row's check pill updates on the next cycle. (AC4)
- **The forge goes away.** GitHub is unreachable for ten minutes; every row keeps its facts and shows "measured 10m ago"; nothing turns green; measurement resumes on its own. (AC6)
- **Nudging.** The user clicks "Message agent" on a conflicting PR; the composer opens to the Builder with the PR, its head commit and "conflicting · 2 checks failing" prefilled; the user edits and sends. (AC12)

## History

- 2026-08-17 — the brief approved by Jackson and posted as issue #6 ([record](../../worklog/2026-08-17-pr-pane-brief.md)): association auto-first, one nudge action, GitHub only behind a seam, no readiness gates.
- 2026-08-19 — every fleet surface merges environments from day one (the cross-device position).
- 2026-09-10 — rewritten as a definition: the Squadron dimension and the multi-environment requirement stated; repository tooling and the wireframe left to the record. Former brief acceptance criteria 1–8 → AC1, AC2, AC4, AC6, AC5, AC12, AC9, AC7.
