---
title: "Cross-device"
kind: definition
---

# Cross-device

## Problem

A person's fleet does not live on one machine. Work agents run on a work server that only the work network can reach; personal agents run at home; a laptop is the client for both. The person wants one inbox and one Fleet page, not one per machine — and eventually wants an agent on one server to be able to ask an agent on another. The prior-art platform tried to replicate identity across machines, never built the transport, and rejected deliveries that were not local ([problems](problems.md): fleet observability, human attention).

## Definition

State can do exactly three things across machines: **authority can replicate, messages can cross, or views can merge.** J5's position is that **authority never replicates.** Messages cross — an Exchange can be delivered from one server to another — and views merge in the client. This avoids replicated identity and multi-master state entirely, and it was built into the communication protocol from the start: delivery is log-first, and a message that crosses Squadrons is two writes, never one transaction, because collapsing them would assume a single host.

The four capabilities, and what each is:

| Capability                                           | Position                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Exchanges between Squadrons on different servers** | Fits the protocol as designed: the delivery pipeline gains a remote-peer step, and the receiving server writes its own received row. What is new is a **peer registry** — which servers may talk, with what credential — and the delivery step. Waits for a real trigger (a second personal machine, a Squadron that must live on a specific OS, or another person) rather than being built ahead of one. |
| **One Squadron spanning servers**                    | **A permanent non-goal.** It would require replicated authority or remote execution. A Squadron lives entirely on one server; an agent that needs a particular machine gets a small Squadron homed there, and Squadrons exchange across servers.                                                                                                                                                          |
| **Merged inbox and Fleet page**                      | **The highest-value, nearest capability, needing nothing server-to-server**: the client already connects to every saved environment at once, and each server's reads merge in the client. Answers route to the server they came from. An unreachable server renders its last-known state with a staleness clock, never as empty and never as fine.                                                        |
| **Any other synchronization**                        | Deliberately none. Worktrees, provider credentials, settings, schedules, cost meters stay server-local by design; views merge their readouts. Role and Crew definitions travel as files. Refusing to sync is the feature.                                                                                                                                                                                 |

**The peer registry is where another person's server attaches**, when that time comes — person boundaries, what may cross, and trust live there, and nothing else in the architecture needs to anticipate other people.

History durability is **client-pulled backup**: each connected client periodically pulls a consistent snapshot from every server it connects to, so the client's existing always-connected fan-out is the backup fabric, with no new infrastructure. Its design — the snapshot endpoint, cadence, retention, restore — is later; the direction is settled.

What this never does: no replicated state, no multi-master, no Squadron migration between servers, no global agent registry (peering is pairwise), no dependence on a relay (direct peering; a relay could later be one transport among others, never a required service).

## Acceptance criteria

1. A Squadron, its agents, and its ledger exist on exactly one server; nothing moves a Squadron between servers.
2. Every person-facing surface that shows fleet state — the inbox, the Fleet page, notifications — merges every connected environment from day one, and each item names its environment.
3. An answer or action taken on a merged surface is routed to the server the item came from.
4. An unreachable server's items render with their last-known state and a staleness clock; they never disappear and never render as healthy.
5. Nothing that is server-local by design — worktrees, provider credentials, settings, schedules, cost meters — is synchronized between servers.
6. Server-to-server Exchange delivery, when built, goes through a pairwise peer registry, and the receiving server records its own received row.

## Scenarios

- **Two servers, one inbox.** The user's client connects to the work server and the home server. An ask from an agent in Billing Migration (work) and one from Support Rotation (home) appear in one inbox, each tagged with its environment; answering each reaches the right server. (AC2, AC3)
- **A server goes dark.** The home server is asleep; its rows stay on the Fleet page with "as of 40m ago" and never vanish. (AC4)
- **A Mac-only job.** An agent that must run on a Mac gets its own Squadron homed on the Mac server; it is asked for results by a Squadron elsewhere through a cross-server Exchange, once peering exists. (AC1, AC6)

## History

- 2026-08-19 — the position settled with Jackson: authority never replicates; former X1–X5 (this file's earlier form was the register). Grounded in the remote-hosting research and the A2A design.
- 2026-09-10 — rewritten into the definition shape. Former identifiers: X1 → AC1; X2 → AC2; X3 → the sequencing sentence in the first capability row; X4 → the peer-registry paragraph, AC6; X5 → the client-pulled backup paragraph. Personal deployment details (which server is where) removed from the definition.
