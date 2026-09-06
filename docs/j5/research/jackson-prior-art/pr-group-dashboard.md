---
title: "Prior art: Jackson's pr-group-dashboard"
kind: spec
---

# Prior art: pr-group-dashboard

Studied at commit `d407fb7` ("PR Group Dashboard: measure agent-run PR state instead of asking"), 2026-08-14. Companion to `pr-group.md` (the playbooks; this repo is the measurement half). ~3,150 lines, zero dependencies — Node 22 built-in SQLite, server-rendered HTML, no build step. Runs as a user LaunchAgent on `localhost:7317`, self-polling: **agent liveness every 20s, GitHub every 60s**, page reloads every 15s.

## The organizing principle (from the README's first line)

<user_quoted_section>"Live state of every PR Group … so status is measured instead of recalled."</user_quoted_section>

Everything else follows from two design decisions:

### 1. Measured vs asserted — the provenance split is load-bearing

Two classes of table, documented in `schema.sql` itself:

<user_quoted_section>MEASURED - the pollers own these. Wiped and rebuilt freely. Disposable.ASSERTED - agent-authored via the prg CLI. The pollers NEVER touch these.</user_quoted_section>

Pollers write only measured tables (`agent`, `pr_group`, `pr`, `review*`, `check_run`); agents write only asserted tables (`ask`, `decision`, `finding`) through `prg`. GitHub state can be wiped with zero risk to agent-authored content. The UI can always tell the user _which kind of fact_ it is showing — `prg gates` even prints them under separate headers ("MEASURED FROM GITHUB" vs "MEASURED FROM THE BOARD — from rows agents entered") with the caveat: _"verifies that a ruling was RECORDED, not that the ruling was his."_

### 2. Read-only by design

<user_quoted_section>"Read-only is a design decision, not a shortcut: Jackson takes asks to the Spawner and the agents close the loop, so the UI can never hold a state the agents don't know about." (server.js header)</user_quoted_section>

Jackson cannot dismiss an ask from the board. The group closes it with `prg ask answered` after he answers via the Spawner. Single-writer discipline: no state fork between what the human saw and what the agents believe.

## The ask mechanism — the human-question queue

The full data model (`schema.sql`):

```sql
CREATE TABLE IF NOT EXISTS ask (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  sitter_agent_id  TEXT,
  repo             TEXT,
  pr               INTEGER,
  created_by       TEXT,
  created_at       TEXT NOT NULL,
  title            TEXT NOT NULL,
  body             TEXT,
  urgency          TEXT NOT NULL DEFAULT 'soon'
                     CHECK (urgency IN ('blocking','soon','fyi')),
  status           TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','answered','dismissed')),
  answered_at      TEXT,
  answer           TEXT,
  source           TEXT NOT NULL DEFAULT 'cli'
);
```

Lifecycle: any roster seat files it (`prg ask --urgency blocking|soon|fyi --title …` — Builder and Reviewer file directly, not routed through the Sitter, because "the DB is a list, not a channel"); it renders on the group's card under **"Needs you — take to <Spawner>"** with a copy button; Jackson answers through the Spawner conversation; the group records the answer (`prg ask answered --id N --answer …`). The CLI prints, at creation: _"Jackson cannot clear this himself — close it when he answers."_

The answered ask then becomes **evidence**: gate 7 (deferral discipline) accepts an answered ask as proof Jackson ruled on a deferral; a self-typed ticket id is reported separately, "never as equivalent."

## Liveness — the four-state model built on transcript tails

`active` from `traycer agent list` "flaps within seconds" (the baton moves Builder → Sitter → Reviewer inside a minute), so polling it samples busy groups as idle. Instead (`lib/traycer.js` + README):

| State     | Detection                                             |
| --------- | ----------------------------------------------------- |
| `working` | `active: true` right now                              |
| `idle`    | transcript ends with a finished `assistant_response`  |
| `stalled` | transcript ends with an **unanswered `user_message`** |
| `gone`    | absent from `agent list`, or transcript 404s          |

`stalled` is the one that matters — "the 'yeah, the Reviewer is working on that' case where the Reviewer actually died." The parser also extracts _who_ sent the unanswered message and whether it carried a `responseId` — **"another agent is blocked waiting, and the card says so."**

Anti-false-positive machinery, all learned from live operation:

- **2-minute grace** (`PRG_STALL_GRACE_MS`) before the board shouts; below it renders as a quiet "just messaged". Observed transients cleared within one ~20s poll; real deaths persisted for hours.
- **The clock is `unanswered_since`** — how long _the board has observed_ the message unanswered — never silence-since-last-turn (a healthy agent idle 5h that just received a message would be flagged instantly on the wrong measure).
- Once escalated, the card reports two facts separately: "unanswered for at least 1h" (observed floor) and "its last turn ended 11h ago" (real timestamp) — never conflated.
- Real turn timestamps come from scraping Traycer's **undocumented host log** (`~/.traycer/host/host.log`) incrementally by byte offset, because `traycer agent list` returns no timestamps at all. Strictly best-effort; "nothing depends on it."
- **A broken poller goes quiet, not loud-wrong**: if the Traycer CLI returns nothing, the poller skips the write entirely — "a broken poller must go quiet, not report a fleet-wide outage." The UI's staleness clock surfaces the problem instead.

## Never guess — the roster rule

Builder and Reviewer come **only** from the Spawner's `prg group register`; pollers never fill a blank. An earlier version guessed rosters from agent titles and resolved all 8 live groups correctly — and was removed anyway:

<user_quoted_section>"a guess that lands on the wrong agent reports liveness for an agent that isn't in the group — healthy-looking and wrong, which is the one failure this tool cannot afford. A visibly missing roster is strictly better than a plausible fake."</user_quoted_section>

Same instinct throughout: `mergeable: UNKNOWN` renders as "?"; a stub PR row shows `measuring…`; Bitbucket's missing CI renders as `no CI`, never `CI ✓` (a "vacuous pass" with the evidence string saying exactly that); conflicts on Bitbucket are measured locally with `git merge-tree --write-tree` because the API has no conflict flag — "it never guesses 'clean'."

## Attention hierarchy — how the board ranks

The board is a status wall with an attention queue built into its _sort order and badges_ rather than as a separate pane:

- Group rank: **stalled (0) → blocking asks (1) → normal (2) → unstaffed (3)** (`server.js` `rank()`).
- Header rollup: "N groups across M epics · **1 stuck** · **7 asks**"; collapsed sections keep their counts — "hiding a section never hides urgency."
- Badges: `⚠ STUCK`, `PRE-PR`, and `RETIRING · NEEDS YOU` — a group that finished its PRs but **cannot retire until Jackson answers its open asks** is rendered loud, because that's pure waiting-on-human state.
- Closed/merged PRs start collapsed (server-rendered so they never flash open); merged PRs drop off after 48h; only `done` (Sitter-asserted, phase 07) removes a group.

```wireframe
<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
body{background:#0d1117;color:#c9d1d9;font:13px/1.5 -apple-system,sans-serif;margin:0;padding:16px}
.hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
.hdr h1{font-size:15px;margin:0}.hdr .sub{color:#8b949e;font-size:12px}
.bad{color:#f85149}.warn{color:#d29922}.ok{color:#3fb950}.mut{color:#8b949e}
.sec{border:1px solid #30363d;border-radius:8px;margin-bottom:10px;overflow:hidden}
.sechd{background:#161b22;padding:8px 12px;font-weight:600;font-size:12px;display:flex;gap:10px;cursor:pointer}
.card{border-top:1px solid #21262d;padding:10px 12px}
.card.stuck{background:rgba(248,81,73,.05);border-left:3px solid #f85149}
.badge{display:inline-block;border-radius:10px;padding:1px 8px;font-size:10px;font-weight:700;margin-left:6px}
.b-stuck{background:rgba(248,81,73,.16);color:#f85149;border:1px solid #5a2d2d}
.b-prepr{background:rgba(210,153,34,.15);color:#d29922;border:1px solid #4d3d12}
.b-ask{background:rgba(210,153,34,.15);color:#d29922;border:1px solid #4d3d12}
.pill{display:inline-block;border-radius:4px;padding:0 6px;font-size:10px;margin-right:6px;background:#21262d}
.roster{color:#8b949e;font-size:11px;margin:4px 0}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:3px}
.d-work{background:#3fb950}.d-idle{background:#484f58}.d-stall{background:#f85149}
.asks{background:rgba(248,81,73,.04);border-top:1px solid #30363d;margin-top:8px;padding:6px 10px}
.asks h3{font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:#f85149;margin:0 0 4px}
.ask{font-size:12px;padding:2px 0}
.prrow{font-size:12px;padding:3px 0;color:#c9d1d9}
.mono{font-family:ui-monospace,monospace;font-size:11px}
</style></head><body>
<div class="hdr"><h1>PR Groups</h1><div class="sub">9 groups across 6 epics · <span class="bad">1 stuck</span> · <span class="warn">7 asks</span> · agents 12s ago · github 41s ago</div></div>
<div class="sec">
 <div class="sechd">Spawner: obs-cleanup-lead <span class="mono mut">6dafc01f</span> <span class="mut">· epic 69dae7ed · 3 groups · <span class="bad">1 stuck</span> · <span class="warn">2 asks</span></span></div>
 <div class="card stuck">
  <b>logging-batch-3</b><span class="badge b-stuck">⚠ STUCK</span><span class="badge b-ask">2 asks</span>
  <div class="bad" style="font-size:11px">Reviewer: unanswered for at least 1h (from Builder, reply expected) · its last turn ended 11h ago</div>
  <div class="roster"><span class="dot d-work"></span>Builder <span class="dot d-stall"></span>Reviewer <span class="dot d-idle"></span>Sitter</div>
  <div class="prrow">#9234 <span class="mono">8f31ab2c</span> <span class="pill ok">OPEN</span><span class="pill ok">CI ✓</span><span class="pill ok">MERGEABLE</span><span class="pill">review: APPROVED</span> threads 2/14</div>
  <div class="prrow mut">#9304 backport <span class="pill">OPEN</span><span class="pill warn">CI running</span></div>
  <div class="asks"><h3>Needs you — 2 · take to <b>obs-cleanup-lead</b></h3>
   <div class="ask">⛔ <b>[blocking]</b> Merge-order call: land #9234 before or after the chart bump? <span class="mut">📋</span></div>
   <div class="ask">🕐 <b>[soon]</b> Deferral ruling on finding #41 (retry storm in dev only) <span class="mut">📋</span></div>
  </div>
 </div>
 <div class="card">
  <b>tracing-ctx-prop</b><span class="badge b-prepr">PRE-PR</span>
  <div class="roster"><span class="dot d-work"></span>Builder <span class="dot d-work"></span>Reviewer <span class="dot d-idle"></span>Sitter</div>
  <div class="prrow mut">no PR yet — building</div>
 </div>
</div>
<div class="sec"><div class="sechd">Spawner: cost-reduction-lead <span class="mut">· epic d3d128c8 · 2 groups · <span class="warn">1 ask</span></span></div></div>
<div class="sec"><div class="sechd mut">Unstaffed · 1 · roster not registered</div></div>
<div style="color:#8b949e;font-size:11px;margin-top:10px">read-only by design · asks are closed by the group, not here · merged PRs drop off after 48h</div>
</body></html>
```

## The PR state model

Per PR (`pr` table): forge (`github`/`bitbucket`), state, draft, branches, head SHA, `mergeable`, `merge_state_status`, `review_decision`, check rollups (state/total/failed/pending/failed-names), backport linkage (`backport_of`), stack topology (`stack_parent/root/depth`, computed per-repo), thread rollups (total/unresolved/truncated). Reviews keep both **latest-verdict-per-reviewer** (what gates use) and **every submission** (a reviewer who COMMENTED then APPROVED is two rounds). Review threads track bot-vs-human replies (`non_bot_replies` — "CodeRabbit always acks a disposition and takes it back"), `trailing_agent_replies` (the group replied again without being answered), and who resolved.

Data flow: registry (`~/.traycer/pr-sitter/registry/*.json`, read-only) → plus **any PR an agent attached** (attaching alone must be enough to get polled, or a group sits invisible) → plus `watch.json` manual additions. One GraphQL call per PR, concurrency 8, with a re-ask pass for GitHub's lazily-computed mergeability.

## Group lifecycle

`active` → `retiring` (poller-set when all PRs closed **and no open findings**) → `done` (Sitter-asserted at phase 07; only this removes it). **Retirement is not terminal**: `prg group reopen --reason "<why>"` is required to say why, renders as a banner, and the open-finding guard prevents the reopen from auto-retiring again within one poll. Groups appear **before their PR exists** (registered at spawn; `PRE-PR` badge; LEFT JOIN everywhere — an inner join "silently defeats the point of registering early").

## Other notable decisions

- **The board spans every epic** (6 at study time) — `traycer agent list --all` is user-scoped, not epic-scoped; `TRAYCER_EPIC_ID` is only a connection anchor. The fleet view Jackson needed is inherently cross-epic; Traycer's own UI isn't.
- **One implementation of the ten readiness gates** (`lib/gates.js`) shared by board and CLI — "a second implementation would drift, and a Sitter would see a different answer from the one on Jackson's screen." Gates 1–6 measured with evidence inline; **7–10 print as definitions and are never evaluated** — "they're judgement, and the command says so rather than implying it checked them."
- **`prg gates` measures live, never serves cache silently** — on GitHub failure it shows cached rows behind `!! COULD NOT MEASURE LIVE`, tells the agent "Do NOT report these as measured," and exits non-zero.
- **Findings ledger**: one home per finding, chosen where raised, never copied (deliberately no `--thread` flag); a deferral IS a finding with `status='deferred'`; the reviewed SHA is "CONTEXT on a finding, never part of its identity — force-pushes rewrite SHAs."
- Fail-safe identity: if the dashboard's pinned Traycer agent is archived, "the poller goes quiet and the board's clock goes red rather than reporting agents dead."

## What the platform should give for free

Every one of these is hand-built scaffolding compensating for a missing platform primitive:

1. **Agent liveness with real timestamps.** He scrapes an undocumented 11MB host log by byte offset because the platform exposes only a flapping `active` boolean. Our platform: lifecycle events with timestamps as first-class API (hook-sourced, per the typed-silence design).
2. **Stall detection with blocked-waiter linkage.** The transcript-tail parser reimplements, by 20s polling, exactly what our communication graph gets from events: unanswered thread + who's blocked + `responseId`. His grace-period and observed-floor lessons should inform our stall-report UX.
3. **The durable human ask queue.** `ask` with urgency tiers, forced agent-side loop closure, answer-as-evidence — this is the human-node inbox, built externally. Fold in (Jackson has already agreed in principle).
4. **Group/team roster as a primitive.** Spawner-asserted membership, no inference — our roles/teams layer should make the roster a platform object so no one has to register it out-of-band.
5. **Measured-vs-asserted provenance.** The dashboard should always know and show whether a fact was measured by the platform or claimed by an agent. This belongs in our event/read-model design, not just in UI copy.
6. **Attention ranking.** Stalled > blocking-asks > working > unstaffed, with rollup counts that survive collapsing. Directly reusable as the fleet dashboard's default sort.
7. **Cross-epic fleet view.** The platform UI should natively aggregate across epics/containers; his board exists partly because Traycer's can't.
8. **Lifecycle with reopen-and-reason.** Retiring/done/reopen (reason required, rendered loud) — richer than any state model in T3 or Traycer, and proven necessary by post-merge defects.
9. **External-artifact state (PRs) as a platform feed.** One GraphQL-per-PR poller with stack/backport derivation, forge abstraction, and honest `CANNOT MEASURE` semantics — reusable shape for the PR pane, and generalizable to other watched artifacts (incidents, dashboards).
10. **Policy checks with one shared implementation.** Agent-facing CLI and human-facing UI must read the same gate code or they drift — a platform "checks" primitive should be defined once and rendered everywhere.
