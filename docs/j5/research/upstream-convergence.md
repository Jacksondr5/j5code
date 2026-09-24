---
title: "Upstream convergence watchlist"
kind: research
as_of: 2026-09-23
---

# Upstream convergence watchlist

Where upstream T3 Code is building toward the areas J5 owns. Each entry says what upstream has, where J5 stands, and what would make us adopt upstream's version or change our own. Rewrite this file at every upstream advance (see [Merging upstream](../process/upstream-merge.md)); `as_of` is the upstream SHA date it was checked against.

Checked against `t3code/codex-turn-mapping` @ `67a2be0fdb` (V2, pingdotgg/t3code#2829).

## Agent-to-agent messaging and control

- **Upstream:** the orchestrator MCP toolkit can send into another thread, wait on it, interrupt it, launch threads (`t3_thread_send`, `t3_thread_wait`, `t3_thread_interrupt`, `t3_thread_launch`, `create_threads`), answer another thread's pending requests (`t3_pending_request_respond`) and reconfigure it (`t3_thread_configure`). Messages sent by agents now carry `senderThreadId` and render "Sent by another agent" with a link to the source thread.
- **J5:** Squadrons, addressable participants, Exchanges (asks and replies), Inbox and delivery receipts. The J5 MCP surface excludes upstream's send, wait, interrupt, launch and queue-mutation tools; the exact list is pinned by the registration test.
- **Watch for:** participant identity, reply/ask semantics, an inbox, or delivery guarantees upstream. Any of those is the signal to rethink the J5 verbs as a layer on top of upstream's. Two exposed upstream tools act on _other_ threads without J5 authority checks: `t3_pending_request_respond` and `t3_thread_configure`. Re-check them each advance.
- **External MCP:** a request on #2829 (2026-09-16) asks for an authenticated external MCP surface for the V2 thread tools. That would overlap the J5 machine senders and the `j5 a2a` CLI.

## Launch, workspaces and parallel agents

- **Upstream:** workspace-aware launches (new worktree, existing worktree, project root), configurable branch names, tracked worktree setup and clone progress. Multi-model send starts the same first message on several models, each in its own worktree. There's no coordination between them: it's for comparing outputs.
- **J5:** `spawn_agent` and Crews create Peer Agents with Squadron homes and briefs. Today they share the caller's checkout (#274). Multi-model send is refused from a saved-agent draft, because a saved agent locks its model.
- **Watch for:** grouping or coordination of fanned-out threads, which would come close to Crews.

## Lineage, subagents and fleet views

- **Upstream:** a thread-details panel with a Lineage section, lineage hover cards, one collapsible subagent card per turn, and subagent history in workspace cards. The Agents right panel was removed.
- **J5:** Squadron placement and provenance, the Fleet page, sidebar spawned-children and Crew chips, persona identity on lineage and subagent rows.
- **Watch for:** cross-thread grouping beyond native subagents, which would mean upstream is approaching Squadrons and the Fleet page.

## Handoffs and history transfer

Two different things share the word "handoff". J5 docs call upstream's history transfer a **context handoff** and J5's persona document a **handoff artifact**.

- **Upstream:** context handoffs (upstream's "portable handoffs") move a budgeted slice of history (`ContextHandoffBudget`) into a new provider conversation when a thread switches model or provider, is forked, or restarts portably.
- **J5:** persona handoff artifacts under `handoffs/` in project artifacts, with a nudge worker and a composer chip. The native-resume patch refuses a silent context handoff except when the conversation is gone. The future of handoff artifacts is tracked in [#284](https://github.com/Jacksondr5/j5code/issues/284).

## Steering and queues

- **Upstream:** a queue-or-steer follow-up setting, a shared composer dispatch, editing, reordering and promoting queued messages, and held queues after a restart.
- **J5:** adopted upstream's steering and queues in the 2026-09-24 advance. The remaining UX gaps are in the give-back backlog (#276). Held A2A deliveries and limited receivers are in #272.

## Long-running autonomy

- **Upstream:** Limited state for usage limits, snoozing until the reset, opt-in auto-resume, scheduled tasks across environments on a shared Scheduler, and startup failures that retry and then fail visibly.
- **J5:** committed Stop also beats usage-limit auto-resume; scheduled creation needs a Squadron (#273); a queued-run watchdog. Retire the watchdog if upstream's visible startup failures leave it with nothing to report.

## Give-back

Fixes J5 carries that belong upstream are tracked in #276. Offer them once V2 merges upstream.
