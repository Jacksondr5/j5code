---
title: "Upstream substrate — what J5 consumes, rebuilds, and builds"
kind: definition
---

# Upstream substrate

## Problem

J5 is a tracking fork of T3 Code. Upstream ships a great deal of machinery that J5 needs — provider adapters, an event-sourced core, thread creation, checkpoints — and some machinery that carries an opinion about how agents are organized, which is the opinion J5 exists to replace. Without a stated line between the two, every feature would re-decide which upstream mechanism to build on, and the agent-facing tool surface would grow by accident with each upstream rebase. This definition draws the line once.

## Definition

### The organizing line

The Subagent and Peer Agent distinction (see the [glossary](../glossary.md)) sorts upstream code. **Subagents belong to providers**: the platform cannot control their creation and does not try; upstream renders them; J5 only observes. **Peer Agents belong to J5**: everything the platform says about spawning, membership, placement and messaging applies to Peer Agents and only to them.

Every upstream mechanism is judged by one question: _does it carry an opinion about agent organization?_ Topology-free plumbing is consumed as-is. Organization-shaped opinion is replaced by J5's own systems.

### The four dispositions

| Disposition                               | Upstream mechanism                                                                                                                                                                                                                                                                                                                                                                                                        | Why                                                                                                                                                                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Consume as-is**                         | Provider adapters and turn machinery; the event-sourced core (commands, events, projections, receipts, the outbox); thread creation with settings inheritance; per-thread interrupt and archive; thread-send delivery with its queue and steer modes; checkpoints; run-lifecycle events as an observation feed                                                                                                            | Topology-free plumbing. J5 calls these through their public command seams and never writes into upstream projections directly.                                                                                                                                                |
| **Consume as record, never behavior**     | Thread lineage (the parent thread and the relationship to it)                                                                                                                                                                                                                                                                                                                                                             | Needed for forks and for rendering provider-native Subagents, and a read-only source for deriving provenance when a creation bypassed J5. Never a source of lifecycle, display or organization for Peer Agents, which are created with root lineage and need nothing from it. |
| **Rebuild — J5 owns the organization**    | Spawning (upstream's delegation) becomes J5's spawn verb: root-thread creation, the Registrar, placement, and a brief that carries the task and whether a reply is expected. Lifecycle (upstream's cascade) becomes J5's single-target stop and archive verbs. Organization display (upstream's lineage panel) becomes a hierarchy read from placement and provenance; the lineage panel remains for Subagents and forks. | These carry upstream's structure-is-the-spawn-tree opinion.                                                                                                                                                                                                                   |
| **Build — nothing exists on either side** | Re-surfacing an open Exchange to a receiver that deferred it (inbox and Memo territory); orphan and runaway observability (observe through silence machinery, never auto-kill); Squadron creation.                                                                                                                                                                                                                        | Named build items, each with its own definition.                                                                                                                                                                                                                              |

### Transport versus communication

Upstream's thread-send, and the server seam beneath it, is **transport**: it injects text into a thread and nothing more. Agent-to-agent communication is transport **plus the record**: the envelope naming the sender and Squadron, the ledger row that makes the message part of the communication graph, the Exchange and what it owes, the delivery receipt, and silence measurement. J5's `send_message` is upstream's thread-send wearing that record. A raw thread-send between agents is untracked peer communication — it can cause the exact silent stall the ledger exists to make visible — so J5 consumes the seam server-side and the raw tool never appears on the agent surface.

Delivery to a busy agent queues behind the active turn; steering is the person's act, with one ruled exception for a peer's update into a running Codex Astra turn ([A2A definition](index.md), Delivery).

### The ownership rule

**Upstream owns existence and lifecycle state; J5 tables overlay only organization facts** — Squadron home, placement, provenance, Exchange obligations. J5 writes flow through upstream's public command seams, never into its projections; J5 reads either join upstream state or say explicitly that they may be stale.

**Participanthood is granted only by J5's registration surfaces** — the spawn verb, the composer's Squadron chip, or a controlled seed — and never inferred from a thread's existence or addressability. The case that forces this: Codex-native Subagents get real shadow threads holding live, resumable provider references; they are thread-having and send-capable, and they are still Subagents. Any sweep that absorbs threads into the roster excludes provider-created and Subagent-lineage threads.

### The agent tool surface

J5 replaces upstream's orchestrator toolkit registration with its own subset: a J5-owned toolkit reusing upstream's tool constants, thin handlers delegating to the same service, and a one-line swap in the MCP server layer. Upstream's toolkit stays compiled and untouched — non-exposure, not deletion. The subset is **fail-closed on upstream evolution**: a rebase that brings new upstream tools does not extend the agent surface until someone admits them deliberately, so new agent powers get reviewed against J5's definitions by default.

| Disposition | Tools                                                                                                                                                                                                                                                                                                | Why                                                                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep        | `orchestrator_capabilities` (its handler no longer advertises delegation or app-owned subagents), the scheduling verbs (`schedule_task`, `list_scheduled_tasks`, `update_scheduled_task`, `delete_scheduled_task`), and the observation verbs (`t3_thread_list`, `t3_thread_read`, `t3_thread_wait`) | Observation and self-scheduling carry no organization opinion.                                                                                                                                     |
| Omit        | `delegate_task`, `task_status`, `task_cancel`                                                                                                                                                                                                                                                        | The excluded middle species: a Peer Agent in Subagent dress.                                                                                                                                       |
| Omit        | `t3_thread_send`, `t3_thread_interrupt`                                                                                                                                                                                                                                                              | Untracked twins of `send_message` and `stop_agent` — they bypass the ledger, the Exchange, silence measurement, and Squadron membership.                                                           |
| Omit        | `create_threads`, `t3_thread_start`                                                                                                                                                                                                                                                                  | Raw creation from the agent surface would bypass the spawn verb and the Registrar. Admitting either requires a contract in [agent-tools](agent-tools.md) first, never a registration change alone. |

Upstream's orchestration prompt text steered agents toward delegation and away from thread creation; J5 carries a small tracked edit to it, recorded in the fork inventory.

The J5 verbs themselves — `send_message`, `list_participants`, `spawn_agent`, `stop_agent`, `archive_agent`, `clear_own_ask` — are defined in [agent-tools](agent-tools.md).

### The legacy cohort

Agents spawned through upstream's delegation path before the spawn verb existed are Peer Agents wearing Subagent lineage: registered, durable, placed and provenance-recorded, with a lineage row that says "subagent". They keep working; the species guard reads registration, not lineage.

## Acceptance criteria

1. No J5 code writes into an upstream projection; every J5 mutation goes through an upstream public command seam or a J5-owned table.
2. The agent surface exposes exactly the J5 verbs and the kept upstream tools listed above; every other upstream tool is absent by construction, and a new upstream tool arriving in a rebase is absent until admitted through a contract change.
3. An agent-to-agent message sent through the platform always has a ledger row, an envelope, and a delivery outcome; no raw thread-send is reachable from the agent surface.
4. A thread becomes a participant only through the spawn verb, the composer's Squadron chip, or a controlled seed; a provider-created thread or a Subagent-lineage thread never becomes one by any sweep.
5. A Peer Agent created through the spawn verb has root lineage; nothing about it is derived from upstream's lineage record.

## History

- 2026-08-24 — Subagent and Peer Agent distinguished; delegation excluded from the product surface ([record](../../worklog/2026-08-24-spawn-terminology-session.md)).
- 2026-08-29 — the substrate line drawn: the four dispositions, the ownership rule, the fail-closed tool subset ([record](../../worklog/2026-08-29-substrate-session.md)).
- 2026-08-31 — `create_threads` and `t3_thread_start` omitted; `clear_own_ask` built.
- 2026-09-03 — delivery queues behind an active turn; steering is the person's act ([record](../../worklog/2026-09-03-queue-vs-steer-ruling.md)); 2026-09-04 — the Codex Astra exception ([record](../../worklog/2026-09-04-astra-peer-delivery.md)).
- 2026-09-07 — rewritten into the definition shape; stale rows (the open `create_threads` row, "needed-but-unbuilt" `clear_own_ask`, the pending prompt-text edit, Squadron creation as "nothing exists") corrected to the current state.
