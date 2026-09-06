---
title: "A1 sitter retirement notes"
kind: spec
---

# A1 sitter retirement notes

## Shakedown item: pre-PR liveness blind spot

- **Observed:** After the review baton returned at approximately 17:05 on 2026-08-16, the Builder held an open failed/stalled turn without a commit or reply until Director intervention after 20:15.
- **Cause:** The GitHub-polling watchdog has no visibility into a group before the Sitter attaches a PR with `prg pr attach`.
- **Candidate program repair:** The Spawner performs a heartbeat/liveness sweep for each spawned group until PR attachment, with an alert/nudge threshold and no routine status chatter.
- **Status:** Carry to the group's eventual `DONE` retro; evaluate the program repair separately from A1 implementation.

## Shakedown item: polling failure is silent until recovery

- **Observed:** The GitHub-polling watchdog encountered transient `gh pr view` API connectivity failures for `Jacksondr5/j5code#4` at 2026-08-17T01:13:38Z and 2026-08-17T01:23:40Z. It recovered at approximately 01:38:17Z, after a Sitter wake delay of about 25 minutes (`wake_count=1`).
- **Positive evidence:** The watchdog recovered without corrupting the PR registry or losing the wake.
- **Gap:** The only failure signal was a WARN in the unwatched `~/.traycer/pr-sitter/watchdog.log`; a sustained polling outage would be silent.
- **Candidate program repair:** Alert/escalate to the Spawner or board after N consecutive poll failures.
- **Status:** Jackson explicitly directed no repair now. Carry to the group's eventual `DONE` retro.

## Shakedown item: formal-approval gate mismatches this build's review policy

- **Observed:** `prg gates --pr 4` requires a formal human GitHub `APPROVED` review for gate 1, while Jackson explicitly ruled that disposed CodeRabbit comments plus green applicable checks are sufficient external-review evidence for these builds.
- **Handling:** Board decision #1 records the ruling. Independent Reviewer approval, bot-thread dispositions, applicable CI, and gates 8–10 evidence remain required; Jackson alone merges.
- **Status:** Build-specific exception, not a change to the general PR-group process. Carry the J5 CI/review interpretation to `DONE` retro.

## Additional completed-group observations

- **What worked:** Stationary-tree baton ownership, independent exact-head review, and mutation checks caught the initially vacuous membership-rebuild test and proved its replacement discriminates. The J5-owned migration lane preserved the additive boundary; CodeRabbit triage delivered three valid fixes and a mechanism-based refutation.
- **Fork/CLI friction:** The worktree's GitHub CLI default initially targeted `pingdotgg/t3code`; an unqualified write could have posted on upstream under Jackson's login. The default was corrected mid-flight, but future fork groups should verify it at bring-up and use explicit `--repo` consistently. The J5 schema namespace invariant also arrived late, causing avoidable rename churn.
- **Validation friction:** `vp lint` exits zero even when it emits diagnostics; lint silence was only trusted after a known-bad probe at each reviewed head. Push/PR CI run duplication required exact-head interpretation.
- **Residuals, no tickets opened:** A2 must wire the runtime ledger and reassess cross-process append retries; A5 must provide snapshot-plus-cursor subscription semantics. The receipt-rollback probe was successful but not retained as a regression test. M1 intentionally excludes delivery/exchanges/tools, silence, inbox, graph API, and placement/provenance. These are documented scope seams, not an authorization to start follow-on work.
