---
title: "Upstream substrate — what J5 consumes, rebuilds, and builds"
kind: spec
---

# Upstream substrate ruling (settled 2026-08-29)

This doc governs the fork's relationship to upstream T3's orchestration code: which upstream
mechanisms J5 builds on, which it replaces, and what the agent-facing tool surface exposes. It lives
under `a2a/` because the A2A program forced every decision in it, but its scope is the whole fork.
Session record with the full evidence trail: [substrate session
2026-08-29](../../worklog/substrate-session-2026-08-29.md). Vocabulary of record:
[glossary](../glossary.md) "Spawning" section (ST1–ST5).

## The organizing line

The Subagent/Peer Agent species line (ST1–ST5, 2026-08-24) is what sorts upstream code. **Subagents
belong to providers**: the platform cannot control their creation and does not try (ST4); upstream
renders them properly; J5 only observes. **Peer Agents belong to J5**: all platform law — R21
placement, Squadron inheritance, the creation-time Registrar, ledger participanthood — governs Peer
Agents and only Peer Agents. Every upstream mechanism is judged by one question: _does it carry an
opinion about agent organization?_ Topology-free plumbing is consumed; org-shaped opinion is
replaced by J5's systems.

`delegate_task` was the only occupant of the middle — an app-owned child wearing Subagent
presentation (sidebar-hidden lineage, `origin: "app_owned"` subagent labeling, creation gated on an
active parent run) with Peer-shaped capabilities (durable independent runs that survive the
spawner). ST5 excludes it from the J5 product surface; this doc records the mechanical disposition.
With it gone the two-species world is clean: every creation is either a provider's business or the
platform's law.

## The four buckets

| Disposition                               | Upstream mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Ruling                                                                                                                                                                                                                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Consume as-is**                         | Provider adapters and turn machinery; the event-sourced core (commands → events → projections, receipts, outbox); thread creation with settings inheritance; per-thread interrupt and archive commands; `sendToThread` steer/queue delivery; checkpoints; run-lifecycle events as an observation feed                                                                                                                                                                                                                                                                               | Topology-free plumbing. J5 calls these through their public command seams and never mutates upstream projections directly.                                                                                                                                                               |
| **Consume as record, never behavior**     | Thread lineage (`lineage.parentThreadId`, `relationshipToParent`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Load-bearing for forks and for rendering provider-native Subagents; also a read-only provenance derivation source for creations that bypass J5 surfaces. Never a lifecycle, display, or org-semantics source for Peer Agents — who spawn with **root lineage** and need nothing from it. |
| **Rebuild (J5 owns the org opinion)**     | Spawn (`delegate_task`) → J5 spawn verb: root-thread creation + Registrar + placement; its brief carries the initial task plus whether and what reply is expected. Exchanges with `expect_reply` remain the reply-obligation primitive for later work owed by an existing participant, never a second spawn step. Lifecycle cascade → placement-walking `stop_agent`/`archive_agent` dispatching upstream per-thread ops. Org display (Lineage panel) → hierarchy UI reading placement + provenance; the Lineage panel remains as the structure/debug view for Subagents and forks. | These carry upstream's structure-is-spawn-tree opinion, which is the opinion J5 exists to replace.                                                                                                                                                                                       |
| **Build (nothing exists on either side)** | Open-exchange re-surfacing (a receiver that defers a delivered ask has no "later" — the successor to the retired "auto-wake" question; memo/inbox territory, R24–R35). Orphan/runaway observability (nothing reaps children under any substrate — observe via silence machinery, never auto-kill). Squadron creation UX (SC1–SC4).                                                                                                                                                                                                                                                  | Named build items; each needs its own design pass.                                                                                                                                                                                                                                       |

Transport finding backing the rebuild column (measured 2026-08-29, retained proof databases): the
A2A delivery path is **proven** for the busy-receiver case — asks steer into the receiver's active
turn — and code-verified for the idle case (delivery starts a run when no run is active/waiting;
queued runs are promoted when a blocking run terminalizes). The one v1 proof "failure" was an
instructed silence misread as a delivery bug. `delegate_task`'s completion wake therefore fills no
gap Exchanges leave open.

## Transport vs A2A — the layering law

`t3_thread_send` (and the server seam beneath it, `sendToThread`) is **transport**: it injects text
into a thread and nothing more. A2A is transport **plus the law**: the envelope carrying sender
identity and Squadron, the ledger event that makes the message part of the communication graph, the
Exchange and its reply obligation, delivery receipts, and silence classification. `send_message` is
`t3_thread_send` wearing the law. A raw thread-send between agents is untracked peer communication —
it can cause the exact silent stall the communication graph exists to make visible. Therefore: J5
consumes the seam server-side, and the raw tool never appears on the agent surface.

## The ownership rule

**Upstream owns existence and lifecycle state. J5 tables overlay only org facts** (Squadron home,
placement, provenance, exchange obligations). J5 writes flow through upstream's public command
seams, never into its projections. J5 read paths either join upstream state or tolerate staleness
explicitly.

**Participanthood is granted only by explicit J5 registration surfaces** — the spawn verb, the
user composer (SC3's immutable Squadron chip → Registrar), or a controlled seed. It is never
inferred from thread existence or addressability. The guard case that forces this: Codex-native
Subagents get real shadow AppThreads holding **live** resumable provider thread refs
(`CodexAdapterV2.ts` `registerSubagentThread`, `activeProviderThreadId` set, `creationSource:
"provider"`). They are thread-having and send-capable, and they are Subagents — any future
absorption/backfill sweep must exclude `creationSource: "provider"` and subagent-lineage threads.

## The agent tool surface — `J5OrchestratorSurface`

Mechanism: the fork replaces the upstream orchestrator toolkit registration with a J5-owned subset
toolkit (a J5 file re-using upstream's exported `Tool` constants; thin handlers delegating to the
same `OrchestratorMcpService`; one-line swap in the MCP server layer merge). Upstream's toolkit,
handlers, service, and tests stay compiled and untouched — non-exposure, not deletion.

| Disposition | Tools                                                                                                                                                                                                                                               | Reason                                                                                                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep        | `orchestrator_capabilities` (handler overridden: stops advertising `appOwnedSubagents`/delegation), `schedule_task`, `list_scheduled_tasks`, `update_scheduled_task`, `delete_scheduled_task`, `t3_thread_list`, `t3_thread_read`, `t3_thread_wait` | Observation and self-scheduling carry no org opinion                                                                                                                                                                             |
| Drop        | `delegate_task`, `task_status`, `task_cancel`                                                                                                                                                                                                       | The excluded middle species (ST5), gone whole                                                                                                                                                                                    |
| Drop        | `t3_thread_send`, `t3_thread_interrupt`                                                                                                                                                                                                             | Untracked twins of `send_message` / `stop_agent` — they bypass ledger, Exchange, silence, and Squadron-membership law                                                                                                            |
| **Open**    | `create_threads`, `t3_thread_start`                                                                                                                                                                                                                 | Recommendation on record: drop — raw creation from the agent surface is an unregistered-thread bypass of the spawn verb. Undecided; if kept, their descriptions (which steer callers toward `delegate_task`) must be re-written. |

Companion edits outside the toolkit: `T3OrchestrationInstructions.ts` prompt text steers agents
toward `delegate_task` and away from thread creation — it gets a small in-place tracked edit. Both
touches (the layer swap, the prose edit) go into `FORK.md`'s upstream-touch inventory when the code
lands.

**The property that makes this the right mechanism**: the subset is fail-closed on upstream
evolution. A rebase that brings new upstream tools does not extend the agent surface until someone
deliberately admits them — new agent powers get reviewed against J5 law by default. Rebase conflict
surface: the `tools.ts` exports and one merge line.

Consequence worth recording: with agent-side raw creation dropped and human creation flowing
through SC3's composer chip, the "native creations bypass the wrapper" bound from A6 shrinks to
approximately nothing — the `unknown`-provenance cohort loses both of its sources on this fork.

### The J5 verb surface — including needed-but-unbuilt

The J5 toolkit carries the verbs that wear the law: `send_message`, `list_participants`,
`spawn_agent`, `stop_agent`, `archive_agent`. One verb is **ruled but unbuilt** and is recorded here
so it gets an A-series home rather than living only in a feature doc:

- **`clear_own_ask`** (working name) — a sender closes its **own** open Exchange without a reply
  message. Required by the inbox design's flow 2 (IB1b,
  [`features/inbox.md`](../features/inbox.md) "Platform dependency" block): an agent's ask lands in
  the human inbox, the human resolves it in direct chat instead of the inbox answer API, and the
  agent then withdraws its ask so the inbox item legitimately exits. Semantics: sender-judged
  closure (R3) applied to the sender's own withdrawal; refuses non-sender callers; emits a ledger
  event so the closure is visible in projections (inbox status, Exchange state, the eventual A5
  graph). Until it ships, in-thread-resolved asks linger open in the human's queue — the known gap
  the inbox doc tracks.

## Legacy cohort

Children spawned through the A6 wrapper's `delegate_task` path before this ruling are **Peer Agents
wearing subagent lineage**: registered participants with durable independent runs, placed and
provenance-recorded, whose upstream lineage row says `subagent`. They keep working; the species
guard reads registration, not lineage, so they are unaffected. No migration is required; the cohort
is bounded and dogfood-scale.

## Open doors (deliberately, not forgotten)

- `create_threads` / `t3_thread_start` on the agent surface (table above).
- Open-exchange re-surfacing for idle receivers (build item; memo/inbox design).
- Orphan/runaway observability policy (build item; silence-machinery surfacing).
- Forks/checkpoints session: how the lineage record's non-org consumers coexist with Peer Agent
  org semantics (flagged 2026-08-29, not yet scheduled).
- May Crew members spawn solo Peer Agents — stays open per `features/crews.md` (Deferred); nothing
  in this ruling leans either way.
