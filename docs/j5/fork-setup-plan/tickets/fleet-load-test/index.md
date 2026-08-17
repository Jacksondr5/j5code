---
title: "T6 — Fleet load test & provider smoke"
kind: ticket
status: 2
---

# T6 — Fleet load test & provider smoke

**Goal:** validate the v2 orchestrator holds up under fleet-scale concurrency (the retired decision-gate, now validation), and learn which provider drivers work on Jackson's machine. This is also our first hands-on with the v2 dispatch path we'll build on.

## Scope

- **Load test:** script ~30 concurrent delegated agents (via v2's `delegate_task` / `create_threads` MCP tools or the WS command path — whichever is scriptable headlessly; the orchestrator's `KeyedSerialExecutor` per-thread dispatch is the thing under test). Use a cheap/fake provider where possible — check whether upstream's replay/test fixtures or a stub driver can stand in for real CLIs so the test measures *orchestration* cost, not model latency. Measure: command dispatch latency (p50/p95) at 1 vs 30 active threads, server memory over the run, event-store growth.
- **Provider smoke:** with real CLIs installed on Jackson's machine (at minimum Claude Code + Codex), run one real turn per available driver; record which of the five drivers (codex, claudeAgent, cursor, grok, opencode) are usable day one and any version pins.
- Deliverable: sub-artifact `fork-setup-plan/load-test/index.md` — method, numbers, pass/concern verdict against "30 concurrent agents feels interactive", plus the provider support matrix.
- If results show contention or unbounded growth: report with evidence; do NOT attempt orchestrator fixes in this ticket (reach back to the Director — that changes roadmap priorities).

## Out of scope

Performance fixes. Long-soak (24h) testing. Providers Jackson doesn't have CLIs for.

## Dependencies

**T2** (building, running app). Parallel with T3/T5 is fine (unbranded is OK here).

## Acceptance

`load-test/index.md` with reproducible script location (committed under a new `scripts/j5/` or similar add-only path), the latency/memory numbers, and the provider matrix.

## Result — 2026-08-15

Implementation head `e7597dac8324d0f0c30a6c0b3956959092606c29` (initial harness `e3fe89858`, review hardening `e7597dac8`) adds:

- `scripts/j5/fleet-load.sh`, an fnm/`.nvmrc` launcher.
- `apps/server/src/j5/fleet-load.ts`, an isolated file-backed production-v2 dispatch harness with a no-network stub provider.

Five fresh runs passed the 30-thread target. Median one-thread p50/p95 was 1.102/3.404 ms; median 30-thread p50/p95 was 0.700/1.017 ms; the median concurrent batch completed in 22.809 ms. Median peak RSS growth was 5.61 MiB. Every run reconciled exactly 90 returned events with 90 durable unified v2 events and a 4.01 MiB SQLite/WAL/SHM footprint increase.

Provider smoke: `codex` 0.147.0 and `claudeAgent` 2.1.232 are installed, authenticated, J5-ready, and each completed a real in-app turn. Cursor, Grok, and OpenCode are not installed; Cursor is also disabled in the fresh default settings. No unavailable provider was installed in this validation ticket.

Full method, five-run ranges, interpretation, provider matrix, isolated Claude database proof, limitations, and reproduction commands are in `fork-setup-plan/load-test/index.md`.

CodeRabbit found two valid pre-merge gaps. The launcher now changes to its resolved repository root before Node starts, and `verdict: pass` now also requires returned event count to equal durable event growth. The absolute launcher was rerun from `/tmp` and returned `reconciled: true`.

PR [#3](https://github.com/Jacksondr5/j5code/pull/3) is merged by exact fast-forward. PR run [31906140442](https://github.com/Jacksondr5/j5code/actions/runs/31906140442) passed in 10m08s and the parallel push run passed in 11m15s on exact head `e7597dac8`. CodeRabbit's follow-up reported no actionable comments. Remote `j5/main` resolves to `e7597dac8324d0f0c30a6c0b3956959092606c29`.
