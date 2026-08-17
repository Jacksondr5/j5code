---
title: "Plan: fork & setup (backlog item 1)"
kind: spec
---

# Plan — Fork & setup

**Settled 2026-08-15:** app name **J5 Code**; repo **`github.com/Jacksondr5/j5code`** (public proper fork of `pingdotgg/t3cod`e); bundle ID `codes.jackson.j5code`. Ticket breakdown in `tickets/` (T1–T6): repo-setup → build-baseline → rebrand → ci-packaging, with planetscale-investigation (T4) fully parallel and fleet-load-test (T6) parallel after build-baseline.

**Pin advance 2026-08-15:** the original `77168d081` pin was force-orphaned before any J5 build or baseline. After reviewing the rewritten range from merge-base `038560e58` to live tip, the setup pin deliberately advanced to **`993407dd9e57f1edf2f5681d70140bfefeca93cc`**. PR #2829 is open and no longer a draft. `FORK.md` retains both pin decisions and the reviewed delta summary.

**Goal:** a rebranded fork of T3 Code that Jackson can build, run, and ship as a desktop app on his own accounts, tracking upstream, with nothing pointing at pingdotgg infrastructure. **Definition of done:** Jackson launches our-branded desktop app built from the fork, drives an agent locally, and reaches a second machine over Tailscale or SSH — with zero pingdotgg cloud dependencies configured.

## Fork point & git strategy

- Fork `pingdotgg/t3code` into Jackson's GitHub; pin the working branch to a recorded reviewed tip of `t3code/codex-turn-mapping` (currently `993407dd9`, deliberately advanced 2026-08-15 after a force rewrite).
- Remotes: `upstream` (pingdotgg) + `origin` (ours). Our work lands on branches off the pinned tip.
- Rebase cadence: while #2829 remains open and moving, advance the pin *deliberately* (weekly, reviewed) rather than chasing daily reconciles. After #2829 merges to main, switch to monthly rebases on upstream release tags. Squash-merge mitigation: all our changes in new files (add-don't-modify), so they cherry-pick cleanly onto any new base.
- Write the discipline down in the fork: a short `FORK.md` — add-don't-modify rules, rebase runbook, what upstream files are off-limits to edit.

## Rebrand (minimal-churn)

- Bundle IDs (~6 sites) and app display name renamed immediately (avoids accidental collision with installed T3 and their update feed).
- Do NOT mass-rename `T3CODE_*` env vars or internal names — they're upstream-churn surface; our brand lives at the packaging layer.

## Cloud-dependency matrix (the PlanetScale question)

All cloud config flows through `scripts/lib/public-config.ts` (7 public values); absent config degrades gracefully — local/LAN/Tailscale/SSH is a fully working product with no `.env` at all.

| Dependency | What it's for | Our call (initial) |
| --- | --- | --- |
| Cloudflare relay + tunnel + **PlanetScale** | T3 Connect relay only — the Worker (`infra/relay`) brokers credentials/endpoints for internet access without VPN; PlanetScale is that Worker's database, nothing else | **Skip — don't deploy the relay.** Tailscale + SSH cover Jackson's multi-machine reality. Investigation task below confirms scope + a local-friendly fallback (D1/SQLite) if we ever want relay. |
| Clerk | Auth for relay/cloud features | **Skip for now** (nothing needs it without the relay). Jackson's existing tenant slots in later. |
| Expo/EAS, APNs | Mobile builds + push/Live Activities | **Defer** until we want mobile. |
| Axiom | Telemetry | **Leave unset** (off). |
| Tailscale, SSH | Remote access, server-managed | **Keep** — no accounts needed beyond Jackson's existing Tailnet. |

**Investigation task (Jackson's callout):** read `infra/relay` end-to-end — enumerate the PlanetScale schema and queries, confirm nothing outside the relay path touches it, and assess porting the Worker to D1/SQLite for a self-hosted relay later. Output: a short sub-artifact here with a keep/skip/port recommendation. Preliminary read from research: relay-only, safely skippable.

## Build & ship

1. **Build up**: `bun install` on the pinned tip (verify the 15 Effect patches apply cleanly), build server + web + desktop; run the app via the repo's dev scripts (the `test-t3-app` skill covers isolated dev environments + pairing).
2. **Test baseline**: run the branch's suite (913 tests) once on our fork; record failures as upstream-known vs ours. This is our rebase regression baseline.
3. **Desktop packaging**: unsigned/ad-hoc local build first (personal use); simple update story later — product-shaped means keeping the update-feed config pluggable, not building it now.
4. **CI (light)**: fmt → lint → typecheck → unit on our branches, reusing the repo's turbo pipeline; full desktop-build job weekly and pre-rebase.

## Validation

- **Fleet load test** (demoted from decision gate to validation): ~30 concurrent delegated agents through v2's `KeyedSerialExecutor` dispatch; measure dispatch latency + memory. Also serves as our first hands-on with the v2 orchestrator.
- Smoke the five provider drivers against whichever CLIs Jackson has installed; note which we actually care to support day one.

## Risks

- Moving-PR base: mitigated by pinning + deliberate advances; worst case we hold a pin until #2829 merges.
- Effect 4 beta + patched deps: tracking inherits upstream fixes; breakage at `bun install` time is the early-warning signal.
- Upstream notices the fork: MIT + fork-blessed; rename immediately, no upstream infra touched.

## Sequencing & staffing

Rough order: repo + pin + rename → build up + test baseline → dependency matrix confirmation (PlanetScale investigation in parallel) → packaging + CI → load test. Estimated 1–2 weeks of agent work. Staffing per selection guide: one Sol (codex, medium+ reasoning) setup engineer for the fork/build/rename work; PlanetScale investigation is a bounded research task for a Terra; load test scripted by the setup engineer, reviewed by Opus.
