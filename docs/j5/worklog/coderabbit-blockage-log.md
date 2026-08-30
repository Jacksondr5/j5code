---
title: "CodeRabbit blockage log — forgo-decision evidence"
kind: spec
---

# CodeRabbit blockage log

**Purpose (Jackson, 2026-09-01):** track how often and for how long CodeRabbit rate-limiting blocks READY PRs. If recurring and impactful, the decision is to forgo CodeRabbit entirely. Maintained by the Director from Spawner/sitter trigger reports; one row per blockage episode, closed when a substantive run lands (or the PR merges on a named gap).

**What counts:** a PR whose every other gate is met, waiting only on a substantive CodeRabbit run. Vacuous/rate-limited responses are "never reviewed" (standing law). Context for the value side: substantive runs have historically produced ~1–2 real findings per review (PRs #3, #10, #11).

| PR | Head(s) | Blocked from | Attempts (timestamped) | Resolved | Blocked duration | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| #11 | e0639798 | 2026-08-28 (hourly allowance exhausted; reviewer held gate 6 as unmeasurable) | auto: rate-limited; Director on-demand trigger same day | 2026-08-28, substantive run (7 threads) | ~hours | Resolved by trigger; review produced real findings + refutations |
| #18 | 8fb7139d | ~2026-08-31 (first vacuous non-review) | auto x2: vacuous; Director trigger: bounce; sitter trigger 2026-09-01T03:07Z: bounce (named 18-min refill); final staggered attempt pending | OPEN | 1+ days and counting | Pending; named-gap merge option offered to Jackson |
| #19 | 26b02879 | 2026-09-01 | sitter trigger: accepted, run pending | OPEN (queued, not bounced) | — | Pending |

## Decision inputs (updated as episodes close)

- Episodes so far: 3 (1 resolved-by-trigger, 2 open).
- Mitigation in force since 2026-09-01: auto-reviews disabled (.coderabbit.yaml, c46d869fa) — allowance no longer burned on iterating heads. The forgo decision should weigh episodes AFTER this change; pre-change episodes partly self-inflicted by auto+incremental burn.
- Suggested forgo threshold (Director, for Jackson to affirm or adjust): if post-mitigation, substantive runs are unavailable within one working day for 2+ consecutive READY PRs, CodeRabbit's gate leg is dropped from the readiness bar (independent Reviewer + judgment gates remain; the ~1-2 findings/review value is documented as the accepted loss).
