---
title: "A2 Squadron mechanical rename PR"
kind: ticket
status: 1
---

# A2 Squadron mechanical rename PR

J5-only mechanical rename after A2 PR #7: live A2A entity, tables, contracts, services, MCP tools, envelopes, tests, and J5 documentation move from `epic` to `squadron`. It deliberately preserves lifecycle/A2A behavior, opaque ids, migration history, upstream terminology, the fork pin, and all registrar, membership, runbook, and native-hook work.

## PR log

- 2026-08-18 UTC — Pre-PR review approved `95f640015`; low finding #33 requested durable migration-history guidance.
- 2026-08-18 UTC — Delta review approved `48e66c932a03a216a0f25d27d8a76b342f739489`; #33 fixed by comment-only change. PR creation pending.
- 2026-08-19T02:14:42Z — Opened J5 PR #8 at `48e66c932a03a216a0f25d27d8a76b342f739489`; registry armed and dashboard attachment pending verification.
- 2026-08-19T02:15:21Z — Attached #8 to the group and measured gates: mergeable, with CI and external review in progress. CodeRabbit began a review at the exact head; requested the independent Reviewer’s COMMENT verdict for the PR record.
- 2026-08-19T02:17:11Z — Corrected the review-channel instruction under `02-pre-pr.md` and `04-rounds.md`: Reviewer verdict remains internal. Updated the Sitter-owned PR body with exact-head no-semantic-change, migration, and mutation-control evidence instead.
- 2026-08-19T02:19:40Z — CodeRabbit posted two actionable threads at the exact head: tool-access wording and legacy JSON migration validation. Routed both to the independent Reviewer for source-based triage; CI remained in progress.
- 2026-08-19T02:19:50Z — CodeRabbit updated its summary only; both existing thread ids were deduplicated and no new finding appeared. Exact-head CI completed green and the PR became CLEAN/MERGEABLE. Independent bot-disposition check remains in progress.
- 2026-08-19T02:19:50Z — Fresh independent bot triage confirmed both CodeRabbit findings should be refuted and supplied correction points for the replies. It also found an untested foreign-key-rewrite precondition in migration 003; recorded low finding #34 for a bounded migration-test fix after the bot replies land.
- 2026-08-19T02:34:12Z — Reviewer posted one evidence-backed reply to each CodeRabbit thread; CodeRabbit withdrew and resolved both. Re-measured Node 24.14 in-memory SQLite with `foreign_keys=1`, so existing post-migration child-table inserts already cover the FK rewrite; refuted #34 and released the Builder without a new head.
- 2026-08-19T02:35:09Z — READY at `48e66c932a03a216a0f25d27d8a76b342f739489`: CI green, CLEAN/MERGEABLE, real `j5/main` base, no human threads, and both bot threads dispositioned. Independent Reviewer verdict remains APPROVE/no semantic change. Negative controls demonstrated mutation failures (1/2/11 tests); coverage boundary is no live production migration, while the legacy schema/payload path is seeded in focused tests. The recorded j5code readiness correction waives formal GitHub approval; filed board ask #8 for Jackson’s merge and set registry `ready_to_merge`.
- 2026-08-19T04:02:19Z — Jackson merged #8 as squash `fdd04688c7bbb781496003db8e3868cadc00e20d` into `j5/main`. Compared the reviewed head’s J5 A2A/FORK tree to the squash commit with zero diff; no backport or residual source work. Closed board ask #8 and retired the group; registry state set to `done`.
