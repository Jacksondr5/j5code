---
title: "Memos — the agent backlog primitive"
kind: spec
---

# Memos

Feature definition of record, extracted from the problems/goals doc 2026-08-22 (rulings R26, R31–R35 in `../design-review-2026-08-21.md`). The problems it answers (`../problems.md`): coordinators drop things they were supposed to raise later; "let's talk about that later" gets pushed out of context and lost; context is bad memory.

## Why the inbox can't do this

The inbox is an **obligation queue** — every item blocks a sender, demands a reply, and naturally scales with the number of working agents. A backlog is a **non-blocking store** — nothing waits on it, which is exactly why it can grow without hurting anyone. Routing deferred items through the inbox converts non-blocking items into blocking ones and makes the attention problem worse: an inbox with 100 items hurts. Hence a separate primitive.

## The Memo

A **Memo** is a small self-addressed message an agent stores via a platform tool — smaller than a ticket, not expected to be worked immediately. Its context is then free to drop the item safely: the durable store remembers, not the context window.

## Behavior

- **No per-turn injection.** Re-injecting the list every turn would trade one failure (forgotten notes) for another (context rot) — the back-burner is a feature. The platform's leverage is Principle 5-shaped: the tool's existence makes usage likely; the UI makes lapses visible.
- **All Memos are visible to the user — no private Memos.** The user only enters this view with attention to spare, and steering an agent requires seeing everything it intends to do.
- **`resurface_after`** — the one platform-initiated re-injection: "page me after this time." Before the time, the Memo truly rests; after it, it returns stamped with measured time facts (R25). This field is what distinguishes a _deferral_ from a backlog item.
- **Promotion is deliberate.** When a deferred thing becomes a _now_ thing, the agent opens a real Exchange. Never automatic.
- Per-agent ownership; the owning agent resolves or drops its own Memos; evented like everything else.

## UI surfacing

- A **backlog pane** on the dashboard: the pull-based view of all agents' Memos across the fleet — third sibling to the inbox and the observability views (shared UI allowed, shared data model never).
- A badge or status icon on agents whose backlog needs going through.
- A warning when the user is about to archive an agent with open Memos.
- A drawer in the chat for picking the next topic to discuss with that agent.

## Scope position

Memos are the **v1 agent data primitive** — shaped, with clear access patterns (append, list-open, resolve, defer), per the platform boundary. A generic agent-provisionable store stays parked with its named trigger (R30/R34): revisit when cross-machine sync or repeated setup pain makes hand-rolled stores hurt. Backlog candidate, not yet prioritized.
