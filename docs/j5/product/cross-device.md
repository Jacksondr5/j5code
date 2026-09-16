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

| Capability                                           | Position                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Exchanges between Squadrons on different servers** | Fits the protocol as designed: the delivery pipeline gains a peer step, and the receiving server writes its own received row. What is new is **peering** — the mutual record of which servers may talk, at what origin, with what credential — defined below. Nothing about addressing changes: an agent names a participant, the participant's Squadron names the server. |
| **One Squadron spanning servers**                    | **A permanent non-goal.** It would require replicated authority or remote execution. A Squadron lives entirely on one server; an agent that needs a particular machine gets a small Squadron homed there, and Squadrons exchange across servers.                                                                                                                           |
| **Merged inbox and Fleet page**                      | **The highest-value, nearest capability, needing nothing server-to-server**: the client already connects to every saved environment at once, and each server's reads merge in the client. Answers route to the server they came from. An unreachable server renders its last-known state with a staleness clock, never as empty and never as fine.                         |
| **Any other synchronization**                        | Deliberately none. Worktrees, provider credentials, settings, schedules, cost meters stay server-local by design; views merge their readouts. Role and Crew definitions travel as files. Refusing to sync is the feature.                                                                                                                                                  |

### Peering

Two servers that may exchange messages are **peers**. Peering is pairwise and mutual: each server holds a **peer record** for the other — the peer's environment id, the origin this server reaches it at, and the credential the peer issued — and each server sees the other as one more authorized session in its Connections settings, alongside paired devices and machine tokens, and revocable there like them. The set of a server's peer records is its **peer registry**. There is no directory of servers: a server knows only the peers it has been introduced to.

Servers do not find each other; **the client introduces them.** The client is the one party that is already connected to both environments, so peering is an act taken there: it asks each server to issue the other a credential bound to that server's identity, tells each server where the other can be reached, and each server confirms it can reach the other before it records the peer. The origin the client itself uses is a hint, not the answer — a loopback or forwarded address that works for the client may not work for a server — so the person confirms the origin each server will use.

**Peering is invisible to agents.** An agent addresses a participant by its id exactly as it does locally; the platform resolves the participant to its Squadron, and the Squadron to a server — the sender's own or a peer. The address book lists participants homed on peers beside local ones, with their Squadron and nothing more; the envelope names the sender and its Squadron as it always has; no agent tool takes, returns or reveals a server. Where a Squadron lives is a fact the platform knows and the client shows when it matters, never a fact an agent manages.

**A person stays server-local.** A person's participant, their asks, and their inbox belong to each server they use; an ask to a person is delivered on the sender's own server, and the person's view of several servers is the client's merge described above. Peering carries messages between agents, and nothing else.

Delivery across peers is the same delivery with one more step, and it inherits every fact of the protocol: the send is a ledger row on the sender's server, the peer records its own received row, the peer's acknowledgement is the sender's delivery receipt, and failure to reach the peer retries and alarms as any failure does. Everything that flows back — a reply, a silence notice, a lifecycle closure — travels the same path in reverse, which is why peering is mutual: one Exchange needs both directions. Peers reach each other directly at the recorded origin; a relay or tunnel is never a required part of it.

Peering is also where another person's server attaches, when that time comes — person boundaries, what may cross, and trust live in the peer record, and nothing else in the architecture needs to anticipate other people.

History durability is **client-pulled backup**: each connected client periodically pulls a consistent snapshot from every server it connects to, so the client's existing always-connected fan-out is the backup fabric, with no new infrastructure. Its design — the snapshot endpoint, cadence, retention, restore — is later; the direction is settled.

What this never does: no replicated state, no multi-master, no Squadron migration between servers, no global agent registry (peering is pairwise), no server-managed addressing exposed to agents, no dependence on a relay or tunnel (direct peering; a relay could later be one transport among others, never a required service).

## Acceptance criteria

1. A Squadron, its agents, and its ledger exist on exactly one server; nothing moves a Squadron between servers.
2. Every person-facing surface that shows fleet state — the inbox, the Fleet page, notifications — merges every connected environment from day one, and each item names its environment.
3. An answer or action taken on a merged surface is routed to the server the item came from.
4. An unreachable server's items render with their last-known state and a staleness clock; they never disappear and never render as healthy.
5. Nothing that is server-local by design — worktrees, provider credentials, settings, schedules, cost meters — is synchronized between servers.
6. Server-to-server Exchange delivery goes through pairwise peering, and the receiving server records its own received row.

### Merged surfaces

7. Environment labels appear on merged items and choices only when the results span more than one environment; a single-environment client shows none.
8. A connection that can only read shows that environment's Squadrons and asks and refuses to create, launch or answer there, with the control saying why.
9. A count over merged environments is marked incomplete when any environment could not be refreshed, and shows no number when none could be.
10. An environment whose server lacks the fleet features is reported as unsupported, never as empty.

### Peering

11. A server delivers to, and accepts deliveries from, only the servers in its peer registry; a peer record names the peer's environment id, the origin this server reaches it at, and the credential the peer issued.
12. Peering is mutual: peering two environments records each as the other's peer in one act, and removing either side ends delivery in both directions.
13. A peer's credential is an ordinary session of the issuing server, bound to the peer's environment identity and to a scope that permits only accepting deliveries and reading the address book; it appears in Settings → Connections, and revoking it there ends the peering.
14. Peering is done from a client connected to both environments with administrative scope; the person confirms the origin each server will use, which may differ from the one the client uses.
15. A peer is recorded only after the recording server has reached the peer at the stated origin; an unreachable origin is refused with the reason, never recorded.
16. An agent addresses a participant homed on a peer by the same participant id it would use locally; no agent verb takes, returns or reveals a server, and the envelope names the sender and its Squadron exactly as for a local send.
17. The address book lists participants homed on peers beside local ones with their Squadron; a peer that cannot be read is reported as unread in the listing, never omitted silently.
18. A message to a participant on a peer is recorded in the sender's Squadron ledger before the call returns; the peer records its own received row before delivering to the agent's thread; the peer's acknowledgement is the sender's delivery receipt; failure to reach the peer retries and alarms as any delivery does.
19. Retrying one message to a peer never yields a second received row or a second delivery.
20. A reply, silence notice or lifecycle closure for an Exchange across peers travels the peer path back to the origin server and closes or notifies the origin Exchange exactly as a local one would.
21. A person is never addressed across peers: an ask to a person is delivered on the sender's own server.
22. Peers reach each other directly at the recorded origin; no relay or tunnel is required for peering.

## Scenarios

- **Two servers, one inbox.** The user's client connects to the work server and the home server. An ask from an agent in Billing Migration (work) and one from Support Rotation (home) appear in one inbox, each tagged with its environment; answering each reaches the right server. (AC2, AC3)
- **A server goes dark.** The home server is asleep; its rows stay on the Fleet page with "as of 40m ago" and never vanish. (AC4)
- **One server is read-only.** The user's connection to the home server has no operate scope: its Squadrons and asks appear in the merged lists, and the answer box for a home-server ask explains that this connection cannot reply. (AC8)
- **Peering two servers.** The user opens Settings → Connections on their laptop, connected to the work server and the home server, and peers them. Each server confirms it can reach the other at the origin the user confirmed; each lists the other as an authorized session. Revoking either session later ends the peering. (AC11–AC15)
- **A Mac-only job.** An agent that must run on a Mac gets its own Squadron homed on the Mac server. An agent in Billing Migration, on the work server, asks it for results by participant id, as it would ask any peer; the ask is recorded in Billing Migration's ledger, the Mac server records its received row and delivers it, and the reply travels back and closes the Exchange. Neither agent named a server. (AC1, AC6, AC16, AC18, AC20)
- **The home server is asleep.** An agent on the work server asks an agent homed on the home server. The send is recorded, delivery retries and then alarms on the asker, and the work server's address book reports the home server as unread rather than showing nobody there. (AC17, AC18)

## History

- 2026-08-19 — the position settled with Jackson: authority never replicates; former X1–X5 (this file's earlier form was the register). Grounded in the remote-hosting research and the A2A design.
- 2026-09-12 — the Squadron picker, the sidebar's Squadron scope and the inbox merge every connected environment on web and desktop, with labels only when needed, read-only connections, incomplete counts and unsupported servers stated (PR #125, issue #105); AC7–AC10 added.
- 2026-09-10 — rewritten into the definition shape. Former identifiers: X1 → AC1; X2 → AC2; X3 → the sequencing sentence in the first capability row; X4 → the peer-registry paragraph, AC6; X5 → the client-pulled backup paragraph. Personal deployment details (which server is where) removed from the definition.
- 2026-09-16 — peering defined: mutual peer records introduced by the client, ordinary sessions on the receiving side, Squadron-resolved routing invisible to agents, people server-local, no relay or tunnel; AC6 rewritten from a deferral into a criterion; AC11–AC22 and three scenarios added ([record](../worklog/2026-09-16-cross-server-peering-session.md)).
