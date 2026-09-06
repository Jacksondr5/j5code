---
title: "Shared Squadrons — multiple people, one server"
kind: spec
---

# Shared Squadrons

Feature definition of record for the multi-user capability. The goal it serves ([problems doc](../problems.md), [use cases 2a](../use-cases.md)): a team shares Squadrons — when one person goes off shift, the next picks up the Squadron immediately with **no context transfer**; and two humans stand in front of the same agent, removing the Slack/Teams relay from human↔human↔agent workflows. Rulings baked in: R9 and R29 in [the register](../design-review-2026-08-21.md). Backlog candidate — likely post-item-4 (the fleet must be observable by one person before it's shareable between several), and a **deep architecture session is required before any build**.

## What this is — and the two things it is not

Shared Squadrons is a **distinct third capability** in the cross-machine space:

| Capability           | Shape                                                                   | Where it's defined                                 |
| -------------------- | ----------------------------------------------------------------------- | -------------------------------------------------- |
| Cross-device         | one person, several servers; read-models merge in the client            | [cross-device position](../cross-device.md), X1–X5 |
| Federation           | two people's _servers_ exchange messages via the peer registry          | X4 — the designated cross-person seam              |
| **Shared Squadrons** | **several people on one server, sharing the same Squadrons and agents** | this document                                      |

Neither of the other two answers it: no state crosses machines here, and no peering is involved. It's multi-user, co-located.

## Settled now, binding now

These constraints are in force **today**, on everything built from here on — retrofitting multi-user onto singleton assumptions is the expensive path this avoids:

- **The multi-human invariant** (R29): nothing may assume exactly one human. Every human-facing surface — inbox, backlog pane, notifications, addressing — is person-scoped, never singleton-scoped.
- **Person ids** (R9): every ledger row and envelope carries a durable local person id (`human:<id>`). External auth (e.g. Clerk) _binds to_ the existing id later, at whichever seam the architecture session lands on — the id is stable without being authenticated, which is what keeps app login deferred today.
- **Delivery targets are one user or all users** (R29): an agent addresses a specific person, or every person on the server. **No human group management** — one server has a practical ceiling on people and work, and group semantics are complexity with no identified need.

## Recorded doors (open, deliberately undesigned)

- **Duty-based addressing**: shift work implies exchanges addressed to a _duty_ rather than a person — "the on-call," resolving to whoever holds the duty now. Written on the door next to external-systems-as-nodes; not designed.
- Multi-user chat mechanics (two people in one agent conversation), presence, and per-person attribution in shared chats — the architecture session's territory.

## What the architecture session must answer

How multiple authenticated people attach to one server (auth binding, transport, T3's single-user assumptions); attribution and read-state in shared surfaces; what "all users" delivery means for the inbox model; whether shift handoff needs any state beyond what person-scoped surfaces already give. Until that session, this document is the vision plus the invariants — nothing more is designed.
