---
title: "Fleet interviews — synthesis and the platform/non-platform classification"
kind: spec
---

# Fleet interviews: synthesis

Source: 23 interview answers + aggregate stats in `Jacksondr5/pr-group` `interviews/answers/` @ `1f92017` — 3 spawners, 5 coordinators/leads, 5 sitters, 4 builders, 4 reviewers, the dashboard toolsmith, the triage agent, and an unsolicited process-evolution history from the methodology owner. Walked through with Jackson 2026-08-16; **his corrections and classification rulings are baked in below** — this document supersedes any raw reading of the answers.

## Reading caveats (Jackson-confirmed)

- **Methodology eras matter.** v0 watchdog era → research week (8/08–10) → playbooks v1 (8/10) → communication clamp (8/11) → dashboard (8/12–13) → findings ledger (8/13). Retirement ceremony was added late. Read generation-1 stories (the 529-comment reviewer, unregistered parallel reviewers) as *evidence of what happens without the mechanisms*, not as current failures.
- **Era-corrected stats:** the 39% blocking-ask rate mixes early-era noise (since fixed by the never-ask rule — post-fix blocking asks were high quality); the 24-groups-stuck-in-`retiring` figure is inaccurate (many predate the ceremony); the 11-deferrals-without-rulings figure is migration noise, not an evidence-discipline failure.
- **Every agent has a partial view** — even the manager agents. Cross-agent contradictions were adjudicated with Jackson, not resolved by majority.

## The classification lens (Jackson's governing principles)

1. **"AI as a DB" is a fundamental limitation.** Agents asked to hold state hallucinate it. Durable stores with clear access patterns are platform work — the dashboard proved the fix dramatically.
2. **Make parts of the system code.** Just as humans fail, AI fails. The reliability comes from the code around the agents (the scraper that feeds triage, the DB that feeds groups), not from perfecting the agents.
3. **A perfect Reviewer is a non-goal.** The PR process exists precisely to layer more review (AI and human) on top of imperfect review. Complexity spent perfecting one agent makes things worse.
4. **Don't solve role problems with tooling.** Group cohesion, channel discipline, verbosity, work-sizing — these are fixed by writing the right role, better prompting, and assigning the right kind and amount of work. The platform improves *durable state, communication channels, and observability*; it does not legislate behavior.
5. **Resist the perfect-system instinct.** The interviewed agents repeatedly proposed machinery for a system that never fails. Such a system is impossible; classify accordingly.

## PLATFORM — build this

| # | Item | Interview evidence (what it kills) |
| --- | --- | --- |
| P1 | **Durable state objects with clear access patterns** — team/roster, asks, findings, recorded rulings; brief/scope as a versioned, addendable *container* (content stays methodology) | The loudest cross-seat convergence. Kills "what's the status on X" messages, qualifier-shedding relays, scope re-derivation chains, spawn-brief-as-lost-message |
| P2 | **Measured-vs-asserted provenance in every read model** | Proven in the dashboard schema; gates output separates them explicitly |
| P3 | **Lifecycle events with real timestamps + extended silence states** — add notification-lost, succeeded-after-caller-timeout, blocked-on-peer, waiting-on-external-gate, false-stuck/bookkeeping-lag; split waiting-on-human into human-knows / human-doesn't-know | Kills host-log byte-scraping, transcript-tail polling, the 2-minute stall-grace hack, and every false STUCK alert triaged that week |
| P4 | **Transport-level delivery acking, invisible to agents** | Playbook correctly bans agent-level read receipts (ack spam); a reviewer verdict was silently lost in a provider handoff — only transport can fix this |
| P5 | **Completion-pressure work queues for machine-fed work** — delivered ≠ acknowledged ≠ closed-with-outcome; re-wake on ack-without-outcome; digest lanes for known families; context envelope on each item | The triage confession: acked wakes without doing the work, twice, rule didn't fix it, only the questionnaire surfaced the live backlog. "Delivery heartbeat proves the message reached me, not that I did the work" |
| P6 | **Events + full-state reconciliation query — never events alone** | Toolsmith: polling's virtue is self-healing; an event stream without catch-up misses an outage and looks healthy afterward |
| P7 | **Human inbox** — urgency tiers, forced loop closure, the human's answer captured verbatim as a durable, linkable row (answer-as-evidence) | 26/33 asks closed on a text nag alone; rulings currently travel by triple relay with six logged qualifier-shedding incidents |
| P8 | **Durable schedules + named status checks** *(new primitive, settled 2026-08-16)* — host-owned cron (survives session death) with run history and missed-run alarms; registered checks (query + cadence + expected shape) whose latest outcome and staleness render on the dashboard; composes with P5 into schedule → queue → outcome → tile | Every durable machine-driven thing in the fleet lives in hand-rolled launchd *outside* the platform; the watchdog had an 80-hour silent outage nobody noticed; session-scoped monitors die semi-randomly. Absorbs the capability-heartbeat use case (a monitor's silent instrument death = a stale self-check tile). T3 v2's scheduled tasks are the starting point; the deltas are durability, missed-run alarms, dashboard rendering |
| P9 | **Cross-epic fleet dashboard: attention ranking + stall report** | The board spans 6 epics because no existing UI can; rank = stalled → blocking asks → normal → unstaffed |
| P10 | **External-artifact feeds (PR state etc.) with honest cannot-measure states** | Proven shape; generalizes beyond PRs per the beyond-coding bar |
| P11 | **Usage/cost metering per agent and subtree** | One CLI was disqualified from model selection purely by unmeasurability; coordination tokens named the most invisible spend |
| P12 | **Stale-context guard on unarchive/resume** — "the world may have moved; here is current state" | A reviewer unarchived into a frozen snapshot confidently escalated an already-settled question |
| P13 | **Per-seat worktrees as the default** | Shared-tree leaks (mutation edits, detached HEAD, uncommitted-work reads) — small but free to fix given native worktrees |

## NOT PLATFORM — operator lore (feeds default role templates, never mechanisms)

- **Reviewer craft:** mutation testing / negative controls ("can your validation fail?" — called the single highest-leverage sentence), frame-inheritance awareness (a *true* report can still misdirect attention), disclosure when reviewing a test you designed, pre-build hazards yes / pre-measurement findings no, claims-plus-what-I-ran handoffs. Per principle 3: redundancy over perfection.
- **Brief content:** measured-vs-inferred tags on claims (5 independent requests), accepted risks stored with their preconditions, precedence clauses, rules-in-the-brief-not-the-playbook, traps posed as open questions (a narrow verification task certified the wrong premise and nearly shipped empty containers).
- **Channel discipline:** DECISION/BLOCKED-only upward, status-narration suppression, expectReply only when you can write the question down. Prompting and model-tier, not mechanism.
- **Epistemics:** entity-vs-record counts, measured-vs-explained (facts now, causal theories labeled unconfirmed), state claims about *behavior* verified always (the state half moves to P1–P3).
- **Org design:** ask-shepherds, estate-census owners, ratifying role accretion, retirement compliance — human calls; the platform surfaces data (P9) and never forces.
- **Work-sizing:** the scrapped 5-group PR stack was under-explored work meeting its limits, not a tooling gap.

## Boundary rulings (all settled with Jackson, 2026-08-16)

| Item | Ruling |
| --- | --- |
| Brief-as-object | Split: container is platform (P1), content is methodology. "We provide the transport, the user provides the content methodology" |
| Capability heartbeats | No new primitive — composes from P8 + P5 (scheduled self-check whose stale outcome renders as "instruments unverified Nh", distinct from dead/idle) |
| Corrections-chasing-quotations / facts register | Deferred — perfect-system territory; artifacts + links cover it |
| Evidence TTL on deploy boundaries | Non-platform — requires the platform to understand domain causality; too opinionated. Kept as playbook lore |
| Message kind tags | **Cut.** Agents already write "DECISION:" in prose and it works; intent summaries on thread-open cover the legibility need |

## Shelved for V2: the tracking worktree

Recorded so it's recoverable later; Jackson's call: plausible, but workflow-specific and less broadly reusable than the rest — document and revisit.

**Design:** a reviewer-shaped seat gets a "tracking worktree" the platform owns. At every **turn start** (a trigger the platform genuinely controls), before the agent runs: reset to clean (discarding mutation-test residue by design), fast-forward to the branch tip, and narrate the sync into turn context (*"worktree synced: HEAD `abc123` → `def456`, 3 new commits touching 5 files"*). The agent never owns the pointer, so it cannot forget to move it — "you didn't fix anything" churn becomes impossible. **Mid-turn push race:** check whether the seat is mid-turn; if so, the sync requires the Reviewer's confirmation instead of being applied silently (Jackson's addition). Residual cost: hydration of the second checkout (worktree setup hooks). Same-repo worktrees share the object DB, so freshness has zero fetch latency; staleness is mechanically detectable (worktree HEAD vs branch tip on the dashboard; verdicts SHA-stamped by tooling, not recall).

## Open follow-up

**The triage asymmetry** — why do 2+ hour build tasks succeed while clearly-defined per-wake triage degrades into acknowledge-without-completing? Hypotheses (habituation, missing completion pressure, reconstruction cost, no goal gradient) and a 3-experiment protocol pushed to `Jacksondr5/pr-group` `interviews/questions/followup-triage.md`; answers expected in `interviews/answers/followup-triage-<id>.md`. Whatever comes back calibrates P5's design (re-wake cadence, digest thresholds).

## Backlog impact

- **Item 2 (A2A):** add P4 delivery acking and the P3 silence-state extensions to the communication-graph design; the durable log decision is re-validated by every seat.
- **Item 3 (roles):** the spawn brief gets a durable container (P1); the "operator lore" sections above seed default role templates shipped as content, not enforcement.
- **Item 4 (dashboard):** P2 provenance, P9 attention ranking, P5 queue states, and P8 schedule/check tiles are now the pane inventory; PRs (P10) are one feed among several.
- **New cross-cutting item:** durable state objects (P1) + schedules/checks (P8) — the "make parts of the system code" layer that neither T3 nor Traycer has.
