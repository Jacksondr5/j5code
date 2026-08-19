---
title: "PR Pane v1 — product brief (draft for Jackson's review)"
kind: spec
---

# PR Pane v1 brief

**Status: APPROVED by Jackson and POSTED 2026-08-17 → [https://github.com/Jacksondr5/j5code/issues/6](https://github.com/Jacksondr5/j5code/issues/6)** (issues were disabled on the repo; enabled with Jackson's authorization to post). The issue body below is the published text of record; revisions happen on the GitHub issue from here, with this artifact as the design-rationale companion. Written self-contained for human engineers who cannot see this epic's artifacts.

Rulings baked in (Jackson, 2026-08-17): association auto-first, agent-driven explicit attach deferred (raises broader agent↔DB design questions); nudge v1 = message-an-associated-agent only; GitHub-only with forge abstraction kept; universe = agent-associated PRs only; pr-review.jackson.codes ignored; readiness gates do not ship (future generic successor: named status checks).

## ISSUE BODY START

# PR Pane v1: agent-associated PR visibility + "work this PR" nudge

## Context (read this first)

J5 Code is a fork of T3 Code being extended into a **fleet-management platform**: one person running many long-lived AI agents that build code, open PRs, and watch production. This issue is the first workstream of the fleet dashboard: a pane inside the app showing the **pull requests the agent fleet is working on**, with one action — nudging an agent about a PR.

**The governing product principle — this shapes every choice below:** J5 Code builds *primitives* that make agent workflows successful. It must never codify any particular workflow's methodology into the product. The prior art below comes from a specific three-agent PR workflow ("PR Groups") with its own playbook rules and readiness gates — that playbook is *one workflow expressible on the primitives*, never the product's opinion. When you face a design choice, ask "what generic capability does this need," not "how do I productize that workflow." Concretely: the prior-art dashboard computes ten workflow-specific "readiness gates" — **those do not ship**. The pane shows raw measured facts; workflow-defined checks become a separate, generic primitive later.

**Prior art (public, study it):** `github.com/Jacksondr5/pr-group-dashboard` — a zero-dependency Node/SQLite board built to run a real fleet of PR-working agents. Its README is a compressed field manual of operational lessons; the design principles below are distilled from it and from interviews with the agents that used it.

## Principles (inherited from prior art; treat as requirements)

1. **Measured, not recalled.** Every fact on screen is measured from GitHub or from platform state by code — never asserted by an agent from memory, never cached silently past its freshness.
2. **Never guess.** `mergeable: UNKNOWN` renders as "?", a not-yet-polled row renders as "measuring…", an unreachable API renders as a loud staleness clock. A plausible fake is strictly worse than a visible gap. No state may ever *look* green because data was missing.
3. **Provenance is visible.** Measured facts (from GitHub) and asserted facts (a human clicked "associate") are stored and rendered distinguishably. Measured tables must be safely wipe-and-rebuildable.
4. **A broken poller goes quiet, not loud-wrong.** If GitHub or platform state is unreachable, keep the last data with a staleness indicator — never render an outage as "everything is fine" or "everything is dead."
5. **State is read-only; actions route through agents.** The pane never acts on GitHub (no merge, no comment, no close). Its one action sends a *message to an agent* through the app's normal agent-messaging path, so the UI can never hold state the agents don't know about.

## Scope

### 1. PR ↔ agent association

A PR appears on the pane when it is **associated with an agent**. Two association sources in v1:

- **Auto-inferred (primary):** the app owns agents' worktrees and branches. When an open PR's head branch (+repo) matches a branch an agent worked on/pushed from its worktree, associate automatically. Provenance: `inferred`. This must be conservative — a wrong association that renders agent liveness against the wrong PR is the "plausible fake" failure principle 2 forbids. If inference is ambiguous, show unassociated rather than guessing.
- **User-asserted:** the user manually associates a PR with an agent in the UI (and can remove either kind of association). Provenance: `user`.

Explicitly **deferred**: agents associating PRs themselves via a tool (raises broader agent↔platform-state design questions owned elsewhere).

### 2. PR state acquisition

- **GitHub only in v1**, authenticated with the user's existing credentials. Keep a thin forge-abstraction seam (the prior art supports a second forge; we will again) — but build nothing Bitbucket-specific.
- **Poll, don't webhook** (local desktop app; polling is self-healing). Reasonable cadence, configurable. One batched/GraphQL query per PR like the prior art; re-ask for GitHub's lazily-computed mergeability when it returns UNKNOWN.
- Track per PR: state, draft, title, author, base/head refs, head SHA, mergeability, review decision, check-run rollup (state/total/failed/pending + failed names), unresolved review-thread count, timestamps, last-polled-at. Note: **check-run completions do not bump the PR's `updated_at`** — poll checks explicitly (prior-art lesson, learned the hard way).
- Closed/merged PRs stay visible briefly (retention window, config), then drop.

### 3. The pane

- A pane in the app's dashboard area, designed as **one pane among future siblings** (a fleet-attention pane will arrive later, fed by a different data source) — don't hardcode a single-pane layout.
- One row per PR: number/title/repo; state pills (CI, mergeability, review decision, unresolved threads); the associated agent(s) with their current platform liveness chip; staleness clock when polling degrades.
- **Attention-first ordering**: needs-something (failing CI, conflicting, changes-requested) above waiting (CI running, review pending) above green; **stable ordering within groups — rows update in place, never jump under the cursor.** Fixed-height rows; no per-second React re-renders (elapsed timers write to the DOM directly); no animated status dots. These are perf rules the codebase already follows (see `AgentsPanel.tsx` and AGENTS.md's performance notes — match that discipline).
- Follow existing codebase conventions for fork-added code: new files under the `j5/` surfaces (e.g. `apps/server/src/j5/...`), pnpm + `vp` toolchain, see `FORK.md`.

### 4. The nudge (v1's single action)

A "Message agent" action on each PR row: opens the normal agent-message composer **prefilled** with the PR reference, head SHA, and a compact snapshot of the measured state (CI/mergeability/review/threads), for the user to edit and send. It's a proof-of-concept for "work this PR" — richer verbs (e.g. spawn-an-agent-onto-a-PR) come later. The send goes through the app's existing agent messaging path; the pane adds no new channel.

## Non-goals (explicit)

- **No readiness gates or any workflow-methodology logic.** Raw measured facts only.
- No agent-tool-driven association (deferred, owned elsewhere).
- No spawn-agent-on-PR nudge (later).
- No Bitbucket/GitLab (abstraction seam only).
- No acting on PRs from the pane (no merge/comment/close/re-run).
- No fleet-attention/communication pane (separate workstream; just don't preclude a sibling pane).
- No webhooks, no public endpoints.

## Acceptance criteria

1. An agent pushes a branch from its worktree; a PR opened from that branch appears on the pane within one poll cycle, associated, provenance `inferred`.
2. A PR with no inferable agent does not appear until the user associates it; the association shows provenance `user`.
3. CI completion is reflected within one poll cycle even though the PR's `updated_at` did not change.
4. Kill the network: rows keep last-known state with a visible staleness clock; nothing renders green-by-default; restore network → self-heals with no restart.
5. `mergeable: UNKNOWN` renders as "?" and resolves after the re-ask; it never renders as mergeable.
6. The nudge composer opens prefilled and sends through the existing agent-message path; the pane performs no GitHub write of any kind.
7. 20+ PRs: rows update in place with stable order and fixed heights; no continuous repaint (verify against the repo's performance rules).
8. Wipe the measured tables; they rebuild from polling with zero loss of user-asserted associations.

Negative controls required: for each "never" above (never guess, never write to GitHub, never reorder under cursor), demonstrate the check can fail — e.g., feed the UI a null mergeability and show it would catch a green rendering.

## ISSUE BODY END

## Wireframe (review aid only — not part of the issue)

```wireframe
<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
body{background:#0d1117;color:#c9d1d9;font:13px/1.5 -apple-system,sans-serif;margin:0;padding:16px}
.hdr{display:flex;justify-content:space-between;margin-bottom:10px}
.hdr h1{font-size:14px;margin:0}.mut{color:#8b949e;font-size:11px}
.bad{color:#f85149}.warn{color:#d29922}.ok{color:#3fb950}
.row{display:flex;align-items:center;gap:10px;border:1px solid #30363d;border-radius:6px;padding:8px 12px;margin-bottom:6px;height:44px}
.row.attn{border-left:3px solid #f85149}
.row.wait{border-left:3px solid #d29922}
.row.green{border-left:3px solid #3fb950;opacity:.85}
.pill{border-radius:4px;padding:0 6px;font-size:10px;background:#21262d}
.agent{margin-left:auto;display:flex;align-items:center;gap:5px;font-size:11px;color:#8b949e}
.dot{width:7px;height:7px;border-radius:50%}.d-w{background:#3fb950}.d-i{background:#484f58}.d-s{background:#f85149}
.btn{border:1px solid #30363d;border-radius:5px;background:#161b22;color:#c9d1d9;font-size:11px;padding:2px 8px}
.t{font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:300px}
</style></head><body>
<div class="hdr"><h1>Pull Requests</h1><div class="mut">7 PRs · polled 12s ago</div></div>
<div class="row attn"><span class="t">#9384 remove OTel SDK & local stack</span><span class="pill bad">CI ✗ 2</span><span class="pill bad">CONFLICTING</span><span class="pill">threads 3</span><span class="agent"><span class="dot d-w"></span>otel-builder · working</span><button class="btn">Message agent</button></div>
<div class="row attn"><span class="t">#9412 env-aware severity</span><span class="pill warn">changes requested</span><span class="pill ok">CI ✓</span><span class="agent"><span class="dot d-s"></span>sev-builder · stalled 41m</span><button class="btn">Message agent</button></div>
<div class="row wait"><span class="t">#9401 wide-event tags per app</span><span class="pill warn">CI running</span><span class="pill">review pending</span><span class="agent"><span class="dot d-i"></span>chart-builder · idle 6m</span><button class="btn">Message agent</button></div>
<div class="row wait"><span class="t">#9418 probe suppression</span><span class="pill">mergeable ?</span><span class="pill">measuring…</span><span class="agent"><span class="dot d-w"></span>probe-builder · working</span><button class="btn">Message agent</button></div>
<div class="row green"><span class="t">#9377 dead value cleanup</span><span class="pill ok">CI ✓</span><span class="pill ok">APPROVED</span><span class="pill ok">MERGEABLE</span><span class="agent"><span class="dot d-i"></span>cleanup-builder · idle 2h</span><button class="btn">Message agent</button></div>
</body></html>
```

## Seams recorded for later (not in the issue)

- **Fleet-attention pane**: arrives after A2A M5's graph read API; the pane shell must allow siblings — that's the only constraint this brief imposes.
- **Named status checks (P8)** is the generic successor to prg's readiness gates — a future primitive where any workflow defines its own checks and the dashboard renders outcome + staleness. Jackson: "we need to figure out how to convert that to a primitive" — queued as its own design session.
- **Agent-driven association** joins the broader "how do agents write platform state" design (same family as the deferred agent↔DB questions).
