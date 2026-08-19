---
title: "Prioritized backlog (Jackson, 2026-08-14)"
kind: story
status: 1
---

# Prioritized backlog

Decision of record: **fork T3 Code from the orchestration-v2 branch** (`t3code/codex-turn-mapping`; rationale in `../research/t3code/fork-viability/` + `../research/synthesis/`). Priorities set by Jackson 2026-08-14:

## 1. Fork & setup app ✅ _(complete 2026-08-15 — plan + evidence at `../fork-setup-plan/`)_

Delivered: public fork `Jacksondr5/j5code` (`j5/main` @ `e7597dac8`), pnpm/fnm/Rust-1.95 toolchain recorded, zero-failure 8,598-test baseline, J5 Code rebrand with empirically verified state isolation from installed T3, CI gates + weekly full-build, installed ad-hoc DMG (`/Applications/J5 Code.app`), relay/PlanetScale confirmed skippable, and a 30-agent load test PASS (30-thread dispatch p50 0.7 ms, +5.6 MiB RSS) with a reusable harness at `scripts/j5/fleet-load.sh`. Providers ready day one: Codex, Claude Agent.

## 2. A2A communication

Spawn peer agents, communication layer, inbox, communication graph. Steal targets: Traycer's typed silence (7-reason taxonomy), thread-scoped idempotent responseIds, broker-owns-delivery/store-owns-identity split, Communication Graph (exactly-once, gap-free, playback). Base: v2's Orchestrator MCP toolkit pattern + `ThreadManagementService`.

## 3. Agent roles / types

Define agent types, easily spawnable, configurable prompts, "soul" (SOUL.md-style identity). Prior art: Claude `.claude/agents/*.md`, Traycer role claims (runtime dedup half), T3 v2 role labels (one-sentence prompt prefix). The _definition layer_ is ours alone — no one has it.

## 4. PR / Agent dashboard _(scope expanded by Jackson; 4a PR pane opening 2026-08-17 for human engineers)_

Not just PRs: at-a-glance visibility into what all agents are doing — critical for long-running tasks and large fleets. PRs are one pane of that story. Inputs: Jackson's pr-group-dashboard (now running locally), per-PR sitter pattern, T3's AgentsPanel + relationship graph, Traycer's Communication Graph.

**Product principle (Jackson, 2026-08-17): build the PRIMITIVES that make workflows like PR Groups successful — the agent DB storing exchanges + human escalations (= the A2A ledger), a role system geared to multi-agent groups (item 3), PR visibility + work-this-PR nudges (this item) — but do NOT codify the PR Group methodology into the product. Users build their own workflows on the primitives; Jackson's playbook is one expression, never the product's opinion.**

## 5. Cross-machine fleets _(deliberately deferred)_

Includes a broader cross-_person_ A2A story. Jackson's call: both T3 and Traycer will likely make cross-machine/cross-person advances in the coming months — wait and see before making our move. Keep the door open architecturally (routing above the environment boundary; nothing that assumes single-host A2A forever).
