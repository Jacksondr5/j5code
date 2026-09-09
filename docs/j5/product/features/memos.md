---
title: "Memos"
kind: definition
---

# Memos

## Problem

An agent in a coordinating role is told "let's talk about that later," and the later never comes: the item is pushed out of its context by everything that happens next and is lost completely. Agents rely on their context as memory when they should be writing things down; a person steering many agents cannot see what each one still intends to do ([problems](../problems.md): "later" gets lost; context as bad memory; human attention).

The inbox cannot hold this. The inbox is an obligation queue — every item blocks a sender and demands an answer, and it scales with the number of working agents. A backlog is the opposite: a non-blocking store that nothing waits on, which is exactly why it can grow without hurting anyone. Routing deferred items through the inbox turns non-blocking items into blocking ones and makes the attention problem worse.

## Definition

A **Memo** is a small self-addressed note an agent keeps through the platform — smaller than a ticket, not expected to be worked immediately. Once written, the agent's context is free to drop the item safely: the durable store remembers, not the context window.

Every Memo is **visible to the person** — there are no private Memos. The person enters the backlog view with attention to spare, and steering an agent requires seeing everything it intends to do.

A Memo may carry a **resurface time** — "page me after this time." That is the one platform-initiated re-injection: before the time the Memo truly rests; after it, it returns to the agent stamped with the measured time. This is what distinguishes a deferral from a backlog item.

**Promotion is deliberate.** When a deferred thing becomes a now thing, the agent opens a real Exchange. The platform never promotes a Memo on its own.

Memos are **per-agent**: the owning agent resolves or drops its own Memos, and every change is recorded. The person sees them all and nudges through ordinary messages.

The person's surfaces: a **backlog pane** — the pull-based view of all agents' Memos across the fleet, a sibling of the inbox and the Fleet page that may share their look but never their data model; an indicator on agents whose backlog needs going through; a warning when archiving an agent with open Memos; and a drawer in an agent's chat for picking the next topic to discuss with it.

Memos are the shaped **first agent data primitive** — append, list what is open, resolve, defer — and earn their place through those clear access patterns. A generic store that agents can provision for themselves is not part of this; it waits until cross-machine sync or repeated setup pain makes hand-rolled stores actually hurt.

## Acceptance criteria

### The Memo

1. An agent can write a Memo, list its open Memos, resolve one, and set a resurface time on one, through platform tools.
2. A Memo is never delivered to its agent on a turn unless its resurface time has passed.
3. A Memo whose resurface time has passed is delivered to its agent once, stamped with the measured time.
4. Only the owning agent can resolve or drop a Memo, and every change is recorded in the ledger.
5. No Memo is ever promoted to an Exchange by the platform.

### The person

6. The backlog pane shows every agent's open Memos across the fleet, and no other kind of item.
7. Every Memo is visible to the person; there is no private Memo.
8. An agent with open Memos shows an indicator.
9. Archiving an agent with open Memos shows them in the archive dialog.
10. An agent's chat offers a drawer listing its open Memos as topics to discuss.

## Scenarios

- **"Later."** During an incident, the user tells the Captain in Support Rotation "let's talk about the logging improvements later." The Captain writes a Memo; the incident consumes its context; the Memo is untouched. That evening the user opens the Captain's chat drawer, sees "logging improvements", and picks it up. (AC1, AC2, AC7, AC10)
- **Page me.** An agent defers a check with a resurface time of two days; nothing happens for two days; then the Memo returns to the agent with the elapsed time stated, and the agent opens an ask to the user about it. (AC3, AC5)
- **Archiving with a backlog.** The user archives an agent that holds three open Memos; the dialog lists them before confirmation. (AC9)

## History

- 2026-08-22 — the concept, extracted from the problems and goals; former R26 and R31–R35 ([record](../design-review-2026-08-21.md)).
- 2026-09-08 — rewritten into the definition shape. Former identifiers: R26 → Problem (why not the inbox); R31 → Definition (no per-turn injection), AC2; R32 → AC3; R33 → AC7; R34 → Definition (the first data primitive); R35 → AC4. The parked generic agent store (former R30) is recorded in the last Definition paragraph as not part of Memos.
