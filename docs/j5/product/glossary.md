---
title: "Glossary"
kind: definition
---

# Glossary

The J5 vocabulary, in one place, so that a name used anywhere in these docs resolves to exactly one meaning.

**Two kinds of entry.** Most terms name something a product definition owns; for those the entry is an index — the term, a one-line gloss that only identifies the thing, and the definition that owns it. The gloss never states a rule or a property; if a sentence here could be argued with, it belongs in the owning definition instead. A few terms are distinctions everyone must share but that no feature builds — Subagent versus Peer Agent is the model — and for those the glossary is the owner and the entry is the full definition.

**Casing.** A named product concept is written in Title Case — Squadron, Crew, Captain, Role, Manifest, Playbook, Memo, Exchange, Peer Agent, Subagent, Spawning Guide, Registrar — so a reader knows it is our concept and not the ordinary word. Everything else is lowercase, including fleet, agent, participant, inbox, ledger and dashboard. A surface's proper name is Title Case (Fleet page). Code identifiers keep their own spelling.

**Upstream's words.** T3 Code's own vocabulary — thread, turn, project, worktree, provider, session, checkpoint, projection, receipt — is defined in [upstream's glossary](../../internals/glossary.md) and is not restated here. Upstream words that upstream does not define (settled, snoozed, pinned, archived, steer, queue) are used in J5 docs with upstream's meaning; where J5 defines behavior around one of them, the entry below points at the definition that does. J5 does not write its own definition of an upstream word unless a measured confusion requires one.

## Organization

| Term                | Gloss                                                                                              | Owner                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| fleet               | All of a user's agents across every connected server — the totality, never a sub-grouping          | [cross-device.md](cross-device.md)                                                        |
| **Squadron**        | The user-created grouping of agents and their work that everything else is organized under         | [features/squadron.md](features/squadron.md)                                              |
| **Squadron home**   | The one Squadron an agent belongs to, recorded when it is created                                  | [features/squadron.md](features/squadron.md)                                              |
| **Registrar**       | The creation-time step that records an agent's Squadron home                                       | [features/squadron.md](features/squadron.md)                                              |
| **Crew**            | A group of agents that work one task as a unit                                                     | [features/crews.md](features/crews.md)                                                    |
| **Captain**         | Any agent with Crews placed under it                                                               | [features/crews.md](features/crews.md)                                                    |
| **Role**            | A reusable, user-authored definition of a kind of agent                                            | [features/roles.md](features/roles.md)                                                    |
| **Manifest**        | The artifact form of a Crew definition — implementation vocabulary, not a separate concept         | [features/crews.md](features/crews.md)                                                    |
| **Playbook**        | User-authored step content that a Role or Crew follows                                             | [features/playbooks.md](features/playbooks.md)                                            |
| placement           | Where an agent sits in the display tree                                                            | [a2a/substrate.md](a2a/substrate.md) _(moves to the A2A definition when it is rewritten)_ |
| provenance          | The recorded fact of how an agent came to exist — spawned by whom, forked from what, or unrecorded | [a2a/substrate.md](a2a/substrate.md) _(moves to the A2A definition when it is rewritten)_ |
| **Shared Squadron** | Several people sharing one Squadron on one server                                                  | [features/shared-squadrons.md](features/shared-squadrons.md)                              |

## Agents

These entries are the distinctions the whole team must share; the glossary owns them.

| Term                   | Definition                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| agent                  | An LLM-driven participant running in a provider session. The ordinary word, lowercase.                                                                                                                                                                                                                                                                                                                                                                                             |
| participant            | Anything that can send and receive over the communication ledger: agents registered in a Squadron, and people. Provider-native Subagents are not participants.                                                                                                                                                                                                                                                                                                                     |
| **Peer Agent**         | An agent spawned by another agent as a full citizen: it has its own top-level thread, the user can read and talk to it like any other agent, it has an independent lifecycle, and it may run on any provider. The user cannot tell it from a human-created agent without checking its provenance. All platform law about spawning, membership, placement and messaging applies to Peer Agents and only to Peer Agents.                                                             |
| **Subagent**           | Upstream's word, adopted: a worker an agent runs inside its own provider session (Claude Task workers, Codex collab children, Cursor task subagents). The user cannot talk to it, it cannot be moved out of its parent's tree, and it ends with its parent's session. What the user _sees_ of it varies by provider; what never varies is that it is not addressable. The platform cannot control Subagent creation and does not try; it only observes what the provider surfaces. |
| spawn                  | The verb for creating either kind, always qualified — "spawn a Subagent," "spawn a Peer Agent." Unqualified "spawn" in J5 docs means a Peer Agent.                                                                                                                                                                                                                                                                                                                                 |
| Foreground, Background | The two ends of the human-contact spectrum: a Foreground agent talks with the person through chat often; a Background agent reaches the person only through the inbox or its Captain. Agents can sit in between. Owner: [principles.md](principles.md), the human-contact spectrum lens.                                                                                                                                                                                           |
| **Spawning Guide**     | The user-authored guide consulted when spawning: which provider, model and reasoning for which work, and how to write a brief. Owner: [features/spawning-guide.md](features/spawning-guide.md).                                                                                                                                                                                                                                                                                    |

## Communication

| Term                         | Gloss                                                                                                                                                         | Owner                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| message                      | One durable send from a participant to a participant                                                                                                          | [a2a/agent-tools.md](a2a/agent-tools.md) _(A2A definition when rewritten)_       |
| ask                          | A message that opens an Exchange — the receiver owes a reply                                                                                                  | [a2a/agent-tools.md](a2a/agent-tools.md)                                         |
| reply                        | The message that closes an Exchange                                                                                                                           | [a2a/agent-tools.md](a2a/agent-tools.md)                                         |
| plain message                | A message that opens no Exchange; agents may send one to agents, never to a person                                                                            | [a2a/agent-tools.md](a2a/agent-tools.md), [features/inbox.md](features/inbox.md) |
| **Exchange**                 | The reply obligation an ask creates between one sender and one receiver. Never called a "thread"                                                              | [a2a/agent-tools.md](a2a/agent-tools.md) _(A2A definition when rewritten)_       |
| intent                       | The one-line summary an ask carries, shown wherever the Exchange is listed                                                                                    | [a2a/agent-tools.md](a2a/agent-tools.md)                                         |
| urgency                      | How soon a person's answer is needed, set only on asks to a person                                                                                            | [features/inbox.md](features/inbox.md)                                           |
| obligation                   | What an open Exchange is to its receiver: a reply owed                                                                                                        | [features/inbox.md](features/inbox.md)                                           |
| envelope                     | The platform's wrapper around a delivered message that tells the receiving agent who sent it and what it owes                                                 | [a2a/agent-tools.md](a2a/agent-tools.md) _(A2A definition when rewritten)_       |
| communication ledger, ledger | The per-Squadron append-only record of every message, delivery, Exchange and notice — the source of truth for all A2A state                                   | [a2a/substrate.md](a2a/substrate.md) _(A2A definition when rewritten)_           |
| delivery receipt             | The recorded fact that a message reached its receiver's thread                                                                                                | [a2a/substrate.md](a2a/substrate.md)                                             |
| delivery alarm               | The recorded fact that a delivery failed                                                                                                                      | [features/sidebar-and-roster.md](features/sidebar-and-roster.md)                 |
| silence notice               | A platform-authored fact appended when an agent's turn ends without a reply it owed                                                                           | [a2a/substrate.md](a2a/substrate.md) _(A2A definition when rewritten)_           |
| queue, steer                 | The two ways a message reaches an agent mid-turn: queued behind the active turn, or steered into it. Agent deliveries queue; only a person steers, explicitly | [a2a/substrate.md](a2a/substrate.md)                                             |
| human node                   | A person as a participant in the communication graph, keyed by person id                                                                                      | [features/inbox.md](features/inbox.md)                                           |

## Humans and attention

| Term                       | Gloss                                                                                     | Owner                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| person id                  | The durable local identity of one person; nothing may assume there is exactly one person  | [features/shared-squadrons.md](features/shared-squadrons.md)         |
| inbox                      | The person's queue of open asks addressed to them                                         | [features/inbox.md](features/inbox.md)                               |
| **Fleet page**             | The page that shows every agent in a Squadron with its measured status                    | [features/sidebar-and-roster.md](features/sidebar-and-roster.md)     |
| Squadron scope             | The sidebar's selection of one Squadron, or all                                           | [features/sidebar-and-roster.md](features/sidebar-and-roster.md)     |
| **Memo**                   | A small self-addressed note an agent keeps through the platform, visible to the person    | [features/memos.md](features/memos.md)                               |
| backlog pane               | The person's view of all agents' Memos                                                    | [features/memos.md](features/memos.md)                               |
| "Expects reply", "Replied" | The two words reader-facing cards use for an open and a closed Exchange, on every surface | [features/thread-a2a-rendering.md](features/thread-a2a-rendering.md) |
| observability dashboard    | Retired name: what it described is the Fleet page                                         | [features/sidebar-and-roster.md](features/sidebar-and-roster.md)     |

## Lifecycle

| Term    | Gloss                                                                                                                                     | Owner                                                                                                                                  |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| archive | Retiring an agent for good; its record stays readable, its open Exchanges end loudly                                                      | [features/archive-flow.md](features/archive-flow.md)                                                                                   |
| retired | The state of an archived participant                                                                                                      | [features/archive-flow.md](features/archive-flow.md)                                                                                   |
| orphan  | A working agent whose placement parent has been archived                                                                                  | [features/sidebar-and-roster.md](features/sidebar-and-roster.md)                                                                       |
| settled | Upstream's thread-triage state ("I'm done looking at this") and nothing else. J5 docs no longer use "settled" to mean a decision was made | upstream mechanics; see [worklog](../worklog/upstream-settled-vs-archived-research-2026-08-29.md) for the confusion this line resolves |

## Retired names

| Name                             | Now                                                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| epic                             | Squadron. Pre-2026-08-17 records use "epic"; read it as Squadron                                                            |
| team                             | Not a concept. Crew is the group that works as a unit; there is no other grouping                                           |
| thread (as the reply obligation) | Exchange. "Thread" means only upstream's conversation                                                                       |
| delegate_task                    | Not on the J5 agent surface; a Peer Agent spawn carries its task in the brief, and an Exchange carries any later obligation |

## Terms still waiting for an owner

These are glossed above with a provisional owner. The doc-by-doc pass gives them a home: placement, provenance, message/ask/reply/plain message, envelope, ledger, silence notice and queue/steer move into the rewritten A2A definition; Fleet page, Squadron scope, orphan and delivery alarm into the Fleet page definition when the current contract lands.
