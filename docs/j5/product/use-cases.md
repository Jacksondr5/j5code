---
title: "Use cases — the concrete fleets J5 Code must serve"
kind: spec
---

# Use cases

This is the library behind lens 3 of [the machine](principles.md): run every feature through each use case here. A design that only serves one of them is suspect — the platform builds primitives, and a primitive proves itself by serving fleets that look nothing alike. These are the use cases of record today; more will be added as they become real.

Both use cases are live prior art, not aspirations: rough versions of each already run (see [fleet-vision](fleet-vision.md) and the [prior-art studies](../research/jackson-prior-art/index.md)), which is what makes them useful stress tests — they come with observed failure modes, not imagined ones.

## 1. Agentic software development

One person runs many long-lived agents that build code, open PRs, and carry them to merge. The canonical unit is the **PR Group**: a Crew of three Roles — a Builder who writes and tests the code, a Reviewer who reviews independently and responds to human/agent review comments in the PR thread, and a Sitter who monitors the PR, communicates outside the group, and triages CI. Captains run several such Crews in parallel; the human sets direction, makes the calls that bubble up, and watches a dozen open PRs at a time.

What this use case demands of the platform: Crews spawned from definitions and worked with high independence; A2A Exchanges so groups coordinate without the human relaying; PR visibility measured from GitHub, never recalled by agents; Playbooks so long multi-step flows (build → review → babysit → merge) survive context decay; the inbox for the asks that genuinely need the human; the observability dashboard for "why isn't this PR moving."

Characteristic load: mostly Background agents; work enters from humans _and_ from machine events (CI results, review comments); the scarce resource is the human's attention across many parallel work streams. Critically, however, the Captain is a Foreground agent that understands the build targets for its Crews, and may coordinate between them and other agents and the human.

## 2. Production monitoring

A fleet that watches production software using observability data (Dynatrace today). Scraping code runs on a schedule, applies heuristics, and flags anomalies worth an AI's attention; a triage agent investigates, discards false positives, and routes real problems; a Director agent serves as the human's point of contact and spawns Incident Commanders per incident; standing Captains run longer-term programs (logging improvement, cost control, cleanup) with their own Crews. The structure is a long-lived organization, not a task execution — Captains and teams persist for weeks.

What this use case demands of the platform: durable schedules and machine triggers as first-class work sources (`trigger.fired` roots — no human prompt starts the chain); typed silence and the stall report, because almost every agent is Background and nobody watches their chats; deep hierarchy with attention that aggregates upward; cost visibility (one Captain exists specifically to stay in budget); supporting stores (the scraper, the incident DB) living _outside_ the platform.

This use case is the standing test from the fleet vision: **"does this work for the monitoring fleet, or only for coding fleets?"** Any feature that quietly assumes code, repos, or PRs fails it.

### 2a. L2 support — the shared-Squadron chapter (elevated)

A chapter of the monitoring story that brings enough differentiating requirements to stand on its own: a level-2 support team shares Squadrons, so when one person goes off shift the next picks up the Squadron immediately — **no context transfer**. It also puts **two humans in front of the same agent**: today developers relay agent output to each other over Slack/Teams; putting both people in the same conversation removes the relay entirely.

What it demands beyond monitoring: everything in [Shared Squadrons](features/shared-squadrons.md) — the multi-human invariant, person-scoped surfaces, one-user-or-all-users delivery, and eventually duty-based addressing ("the on-call"). It is the reason multi-human constraints bind _today_ even though the capability ships later.
