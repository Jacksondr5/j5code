---
title: "Agent tool boundary session (2026-11-07)"
kind: record
---

# Agent tool boundary session (2026-11-07)

Jackson and an agent (Claude Opus 5.5) settled which of J5's agent tools stay J5's and which follow upstream, now that upstream v0.1.7 brings linked environments. The session ran over 2026-11-06 and 2026-11-07. Its outcome is register entries D1, D2 and D42 in [J5 and upstream](../product/upstream.md), the [agent tool surface](../product/a2a/agent-tools.md), the [substrate](../product/a2a/substrate.md), the [A2A definition](../product/a2a/index.md), [Cross-device](../product/cross-device.md) and the [glossary](../product/glossary.md). Those are the place to read what is current; this record is how the session got there.

## What prompted it

The advance to upstream v0.1.7 left one decision open: whether a delegation from one J5 machine to another should work. Upstream's `delegate_task` to a linked machine calls that machine's `t3_thread_launch`, `t3_thread_read`, `t3_thread_wait` and `t3_thread_interrupt`, and J5 hid launch, wait and interrupt, so the call failed with `Tool 't3_thread_launch' not found`. Jackson deferred it on 2026-11-05 because "these tools are something we're still deciding on for other things". He then asked to resolve the wider tension between J5's and upstream's tools for spawning, managing and messaging agents, starting from the foundations.

## Earlier rulings it built on

- 2026-08-24: `delegate_task` removed as "a Peer Agent in a Subagent costume" (spawn terminology session).
- 2026-08-29: upstream's send, interrupt, wait and launch hidden from agents (substrate session).
- 2026-09-13 and 2026-09-17: `delegate_task` back for personas and for work on another provider.
- 2026-10-11 and 2026-10-12: the per-tool evaluation in #519 kept J5's spawn, send and stop and kept `delegate_task` as it was.
- 2026-10-18: Jackson proposed "upstream owns spawning (possibly with us adding some code), we own A2A", and wanted agents to spawn on remote machines; parked on 2026-10-19 until upstream's links settled.
- 2026-11-05: linked environments adopted as shipped, with no fork cases "to shut down upstream's functionality for the sake of the rule".

## What was found

From reading upstream at v0.1.7 (`322f6544df`) and `main`, and J5 at `j5/main`. Nothing was run.

- J5's tools already run on upstream's engine underneath: `j5_send_message` delivers through upstream's send, J5's stop sends upstream's Stop, and a spawn's worktree is prepared by upstream's launch code. What ran in parallel was the tool the agent sees, plus J5's records.
- v0.1.7 gave `t3_thread_interrupt` a `stop: true` option, upstream's full Stop, the same act `j5_stop_agent` sent.
- Upstream now tells its own agents not to wait on delegates ("Completion wakes this thread, so end your turn"), bounds `t3_thread_wait` at ten minutes by default, and forbids `t3_thread_send` for a new review round.
- Upstream's instructions and evals settle the choice between a native subagent, `delegate_task` and launch with two questions: did the person ask for a thread to talk to, and can the native tool do it. J5's instructions already used the same two, with `j5_spawn_agent` in launch's slot.
- A `delegate_task` child keeps a composer in upstream's app; only a provider's own subagent loses it.
- Upstream's general forwarding to a linked machine passes a call on unchanged, so the other machine can't tell which agent asked. A Peer Agent started there needs J5's own path, as upstream's remote delegation has its own.
- J5's fork placement record comes from the 2026-08-29 Fleet tree design, not from Squadrons.
- Archiving an agent never archived the Peer Agents beneath it (2026-09-22); only a Captain's Crews go with it.

## Rulings

- **The line.** J5 owns who agents are and how they talk, making J5 machines reach each other and messaging across them, Crews, and personas as a parameter. Upstream owns delegates, stopping, waiting, thread housekeeping, scheduling and acting on another machine. Jackson's first draft gave J5 "all cross-server stuff"; it narrowed to messaging across machines once links were kept as upstream's. He accepted the line as one that may move as tools are taken one by one.
- **Background helpers and delegates.** Work an agent hands off and keeps going on is a delegate, as upstream routes it. A delegate is built for one task and any follow-up is its parent's or the person's call; it stays out of the ledger. A helper others need to talk to is a Peer Agent. This settles #336: keep `delegate_task`. The docs call a `delegate_task` child a delegate (#952).
- **Peer Agents stay on `j5_spawn_agent`.** On 2026-11-06 Jackson first accepted wrapping upstream's `t3_thread_launch` with J5's additions. On 2026-11-07 he reversed it: a Peer Agent on another machine needs J5's own path anyway, so the case for wrapping launch was gone, and Peer Agents are J5's. `j5_spawn_agent` gains a way to start one on another J5 machine. Its workspace stays required; Jackson will think through workspaces separately.
- **Stopping.** `t3_thread_interrupt`, addressed by thread id, with `stop: true` as the full Stop. J5 keeps one rule on it: a Captain may stop its own seats whatever their access. `j5_stop_agent` retires.
- **Wait and interrupt** are admitted to agents and link sessions; launch only to link sessions; send stays hidden. Jackson wants a live test of a couple of models' use of wait after `j5_stop_agent` retires.
- **Remote delegates** follow upstream, with J5 extensions Jackson approved even though they edit upstream code, because they extend J5 rather than polish upstream: a persona can be delegated to another J5 machine, and a plain delegate there is held to that machine's model lists.
- **Naming rule.** J5 adds personas and refusals to upstream's tools under upstream's names, and gives a tool a J5 name only when J5 changes what it means. It replaces #519's rule, which `delegate_task` already broke.
- **Crews across machines** are the natural next step after a single agent crossing, filed as #953.

## The adversarial review

A second model (GPT-6.1 Sol) reviewed the rulings with only the rulings and the code in hand. It found nine holes. Jackson set two standing limits on such findings: security and forgery are not design considerations, because J5 runs on a closed, trusted network and "this is not a product we can apply a lot of security against, due to the nature of AI"; and a finding that is upstream's own design is not J5's to fix. With those applied:

- Dropped: a link session's self-declared identity could forge a spawner or `delegatedFrom`; a link carries only modes, for remote delegates; upstream's remote delegation refuses a separate worktree; choosing a machine contradicts cross-device AC16 (already relaxed on 2026-11-05).
- Decided: the Captain's stop exemption is kept on J5's version of interrupt; a spawner on another machine is recorded as an outside agent's is, with no cascade either way; a persona may be delegated to another machine; the workspace stays required.
- Build requirements: one retry key and routes on both machines for a cross-machine spawn; the caller's own access travels with it; two agents waiting on each other joins the wait test.

## Related

#951, the reverse route, would let a VM reach a laptop that can't be reached, so starting work on another machine would work in both directions; until then it works only towards a machine the caller can reach. The cross-machine Peer Agent build and its order relative to the v0.1.7 merge were left for the sequencing discussion.
