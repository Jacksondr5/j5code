---
title: "Shared Squadrons"
kind: definition
---

# Shared Squadrons

## Problem

As agents do more of the work, the need to share them between people grows. A level-2 support team hands a Squadron from one shift to the next and wants **no context transfer**. Two developers already relay agent output to each other over chat — one asks their agent, pastes the answer to the other — and would rather stand in front of the same agent together ([problems](../problems.md): Shared Squadrons; [use cases](../use-cases.md)).

## Definition

**Shared Squadrons** is several people on one server sharing the same Squadrons and the same agents. It is one of three distinct capabilities in the multi-machine, multi-person space, and the only one where no state crosses machines and no server peers with another:

| Capability           | Shape                                                            | Defined in                         |
| -------------------- | ---------------------------------------------------------------- | ---------------------------------- |
| Cross-device         | one person, several servers; views merge in the client           | [cross-device](../cross-device.md) |
| Federation           | two people's servers exchange messages through the peer registry | [cross-device](../cross-device.md) |
| **Shared Squadrons** | **several people on one server, sharing Squadrons and agents**   | this document                      |

Two constraints are in force **now**, on everything built, because retrofitting multiple people onto single-person assumptions is the expensive path this avoids:

- **Nothing may assume exactly one person.** Every person-facing surface — the inbox, the backlog pane, notifications, addressing — is scoped to a person, never to "the user."
- **Every person has a durable person id**, minted locally at first run and carried on every ledger row and envelope. External authentication binds to that id later; the id is stable without being authenticated, which is what keeps login deferred today. Where the binding happens is a later design.
- **An agent addresses a specific person or every person on the server.** There is no group management: one server has a practical ceiling on people and work, and groups are complexity with no identified need.

Doors deliberately left open and undesigned: addressing a _duty_ rather than a person ("the on-call", resolving to whoever holds it now); two people in one agent conversation, presence, and per-person attribution in shared chats.

## Acceptance criteria

1. No surface, projection or tool assumes exactly one person; each is scoped by person id.
2. Every ledger row and envelope carries the person id of any person it involves.
3. An ask can be addressed to one person or to every person on the server, and to nothing in between.
4. A person's id is stable across restarts and does not depend on authentication.

## Scenarios

- **Shift handoff.** The on-shift engineer for Support Rotation goes home; the next engineer opens the same server, sees the same Squadron, the same agents, and the same open asks in their own inbox, and continues without a handover conversation. (AC1, AC3)

## History

- 2026-08-22 — the multi-person invariant and person ids ruled binding now; the capability defined and set apart from cross-device and federation; former R9, R29, and the cross-device position ([record](../../worklog/2026-08-21-design-review.md)).
- 2026-09-08 — rewritten into the definition shape. Former identifiers: R9 → AC2, AC4; R29 → AC1, AC3. The architecture session this capability needs before any build — how several authenticated people attach to one server, attribution and read state in shared surfaces, what "every person" delivery means for the inbox — is that session's agenda, not this definition's.
