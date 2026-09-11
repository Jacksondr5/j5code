---
title: "A7 — Planned rebase when upstream #2829 merges (event-triggered)"
kind: record
---

# A7 — Planned upstream base advance

**Governing artifacts:** `FORK.md` in the repo (pin log + integration runbook), `../../plans/a2a.md` §Base. **Trigger: upstream PR pingdotgg/t3code#2829 merges to main** — this ticket is scheduled work waiting on that event, not a surprise to absorb mid-build.

## Goal

Move the fork's base from the v2 branch pin onto upstream main post-merge, with the A2A work surviving intact.

## Scope

- Detect the merge (whoever notices first — builder, sitter, or Director — flips this ticket to in-progress and tells the Director; pausing mid-flight A2A PRs is the Director's call).
- The September 2026 reviewed integration selects V2 `b9fa1399cfbacf23f35ba9201af8aebe3f41e807`; this does not assert that #2829 has merged. Follow FORK.md's controlled-merge runbook for the later move to main. Freeze inputs, construct the new tree from upstream, reapply the reviewed J5 delta and preserve published J5 ancestry with a genuine merge. Conflicts are expected at documented integration cases and require review; they are not automatically a discipline violation.
- Compare migration IDs, names and implementation hashes before every advance. Refuse unrecognized history changes until an explicit mapping and disposable upgrade proof exist. Preserve independent J5 migration lanes.
- Obtain the full baseline suite through exact-head CI; diff against `../fork-setup-plan/baseline.md`; re-verify the BRANDING.md rename inventory and the A2 clientRequestId dedup gate on the new base.
- Update FORK.md's pin log + the plan artifacts' base SHA references.

## Out of scope

Any feature work. Adopting new upstream features (separate evaluation).

## Dependencies

Event-triggered; can interleave with A3–A6. If it fires mid-A2, the Director decides pause-vs-finish.

## Acceptance

Fork builds green on the new base; baseline suite diff explained line-by-line; A2A tests (whatever has landed by then) green; pin log updated with the reviewed advance; branding re-verified.
