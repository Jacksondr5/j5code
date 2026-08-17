---
kind: ticket
title: "A7 — Planned rebase when upstream #2829 merges (event-triggered)"
status: 0
---

# A7 — Planned upstream rebase

**Governing artifacts:** `FORK.md` in the repo (pin log + rebase runbook), `../../index.md` §Base. **Trigger: upstream PR pingdotgg/t3code#2829 merges to main** — this ticket is scheduled work waiting on that event, not a surprise to absorb mid-build.

## Goal
Move the fork's base from the v2 branch pin onto upstream main post-merge, with the A2A work surviving intact.

## Scope
- Detect the merge (whoever notices first — builder, sitter, or Director — flips this ticket to in-progress and tells the Director; pausing mid-flight A2A PRs is the Director's call).
- Follow FORK.md's runbook: review the delta (the merge may be a squash — never assume our base commits exist in main's history), advance the pin onto the upstream release tag or merge commit, cherry-pick/rebase all J5 commits (they are new-file-only by discipline, so this should be mechanical — any conflict in an upstream file is a discipline violation to flag, not to quietly resolve).
- Re-run the full baseline suite; diff against `fork-setup-plan/baseline/`; re-verify the BRANDING.md rename inventory and the A2 clientRequestId dedup gate on the new base.
- Update FORK.md's pin log + the plan artifacts' base SHA references.

## Out of scope
Any feature work. Adopting new upstream features (separate evaluation).

## Dependencies
Event-triggered; can interleave with A3–A6. If it fires mid-A2, the Director decides pause-vs-finish.

## Acceptance
Fork builds green on the new base; baseline suite diff explained line-by-line; A2A tests (whatever has landed by then) green; pin log updated with the reviewed advance; branding re-verified.
