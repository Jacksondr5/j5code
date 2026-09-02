---
title: "Standing rules — the fleet's dated register of law"
kind: spec
---

# Standing rules

The canonical register of rulings that govern how agents build J5 on this fork. Every entry is one line of law, who ruled it and when, and the defect that motivated it. Nothing here is state: no crew ids, no PR numbers in flight, no allocations. Rules that already live in [pr-groups.md](./pr-groups.md) or in the playbooks (`~/.pr-group`) get a pointer, not a copy.

Owner: the Spawner. A new ruling from Jackson or the Director is appended here in the PR that first depends on it; a superseded rule is struck through with the date, never deleted. Agents brief from this file, not from memory.

## Repo and workspace

1. **J5 content lives only under `docs/j5/`.** Never `CLAUDE.md`, `README`, or any upstream-owned file — every line outside `docs/j5/` is fork divergence to carry forever. _Jackson, 2026-09-01._ Motivating case: the memory audit proposed folding repo facts into `CLAUDE.md`.
2. **The main clone is nobody's workspace.** All lane work happens in a dedicated worktree; crews are bound to a created worktree at staffing, never to the clone directory. _Jackson, 2026-08-30._ Motivating case: Jackson found lane edits in his own clone during a live test — the crew had been staffed with the clone as its working directory.
3. **Migration ids are allocated centrally by the Spawner at staffing; no lane self-assigns.** _Director, 2026-08-29._ Motivating case: two lanes both claimed `006` under different filenames — git merged both cleanly and the migration runner would have broken on the second merge.
4. **A change that relocates or creates a live-state path extends every isolation guard in the same PR, additively.** The old path stays guarded because the old install is still live; tests prove refusal of both. The pre-PR "known gaps" hatch covers genuinely separate work, not guards the PR itself just made incomplete. _Spawner ruling, 2026-08-31._ Motivating case: the server default moved from `~/.t3` to `~/.j5code` while three dev-tooling guards still refused only `~/.t3`.

## What gets built

5. **Pre-dogfood, no legacy-compatibility code ships.** Accommodations for data or states that cannot exist yet are deleted; invariants stay and fail closed loudly. Parent principle: [Simple tools at the frontier](../product/principles.md). _Jackson, 2026-09-01._ Motivating case: a send-time "copy the ambient Squadron into an unselected draft" fallback for drafts no creation door could produce.
6. **Dead code is deleted, not retained for a hypothetical consumer.** Code justifies itself by a reachable caller or a named, imminent one; an orphan is not resurrected to justify an existing diff. _Director, 2026-09-01._ Motivating case: `useThreadActionMenu` — a hook with zero call sites that two authorized seam maps had targeted, carrying a stranded fix.
7. **Seam maps for behavioral changes carry a reachability proof** — call-site evidence that the path is reached, not just that the lines exist. _Director, 2026-08-31._ Motivating case: the same orphan hook; existence was verified, reachability never was.
8. **No build crew staffs until the governing design doc is settled law and the Director has authorized the upstream seam map.** Applies to reworks. _Jackson, 2026-08-29._ Motivating case: a lane built against a design still under revision.

## Evidence and readiness

9. **Any PR with UI changes carries crew-posted screenshots before merge**, and a live pass in a disposable environment precedes the evidence capture for UI tickets. Static-markup component tests cannot fire events, so a green suite proves nothing about interaction. _Jackson, 2026-08-28 (screenshots); Director, 2026-08-31 (live pass as a standard gate)._ Motivating case: three defects in one session — a dead-end creation door, a silently dropped selection carrier, a broken first keystroke — each invisible to every static check and found only by driving the app.
10. **Evidence posting is pre-authorized, permanently.** Screenshots, attestations, and disposition replies with the standard attribution line are posted without asking, then verified against the PR API (posted is not landed). _Jackson, 2026-08-30._ Motivating case: crews stalling on permission prompts from the era when Jackson posted evidence by hand.
11. **PR descriptions never contain bare board-record numbers.** On this fork `#NN` autolinks to upstream issues; the rule inside a ruling goes in the PR as prose, the citation stays on the board. When a description rule lands, every open PR is swept against it immediately. _Jackson, 2026-08-31; retro clause Director, 2026-09-01._ Motivating case: a PR body citing "Decision 88" with the hash mark, which GitHub rendered as a link to an unrelated ticket.
12. **Live provider proofs are class-shaped and budget-gated.** Once a lane's harness proofs are green it holds a standing grant to run its final end-to-end on the cheap Luna tier — isolated disposable state, evidence captured, shutdown after. The Director approves timing only when a usage window is over 75%; non-class-shape runs go to Jackson. _Jackson and Director, 2026-08-30._ Motivating case: proofs consuming provider budget with no one watching the meter.
13. **UI copy follows upstream's measured typography.** Capitalization and label style are read from comparable upstream surfaces, never assumed. _Jackson, 2026-09-01._ Motivating case: a title-case option label on a sentence-case product.

## Pointers

- **Bot review is one CodeRabbit CLI run per PR at the reviewer-clean READY head, no re-reviews; Jackson merges, always; readiness gates.** → [pr-groups.md](./pr-groups.md), rules 6 and 8.
- **A finding inside the PR's own files that fits in a round gets fixed, not boarded.** → playbook `04-rounds.md`; reaffirmed by Jackson 2026-08-31 when he reopened a PR to fix six deferred lows.
- **Process rules that are Jackson's personal practice** — never point a blocking question prompt at the human; never block on Jackson for anything an agent can self-serve; environments stand up first and report with caveats; one browser tab per lane, closed at capture; no bare board numbers — → playbook `00-roles.md`, "Standing process rules".

## Struck

Rules retired with the situation that produced them are listed here so nobody re-derives them: the sidebar seam pre-partition between three specific lanes (lanes landed), the CodeRabbit blockage telemetry log and probe-first protocol (retired with PR-surface bot reviews, 2026-08-30), the four-crew concurrency cap (situational to one weekend), and the no-cascade lane list from the agent-ops migration (every listed lane has since merged).
