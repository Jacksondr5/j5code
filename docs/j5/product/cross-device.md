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

Two servers that may exchange messages are **peer servers** ("peer" alone, in the A2A definition, means another agent). Peering is pairwise and mutual: each server holds a **peer record** for the other — the peer server's environment id, the origin this server reaches it at, the credential the peer server issued and when it expires — and each server sees the other as one more authorized session in its Connections settings, alongside paired devices and machine tokens, and revocable there like them. The set of a server's peer records is its **peer registry**. There is no directory of servers: a server knows only the peers it has been introduced to.

Servers do not find each other; **the client introduces them.** The client is the one party that is already connected to both environments, so peering is an act taken there: it asks each server to issue the other a credential bound to that server's identity, tells each server where the other can be reached, and each server confirms it can reach the other before it records the peer server. The origin the client itself uses is a hint, not the answer — a loopback or forwarded address that works for the client may not work for a server — so the person confirms the origin each server will use.

**Peering is invisible to agents.** An agent addresses a participant by its id exactly as it does locally; the platform resolves the participant to its Squadron, and the Squadron to a server — the sender's own or a peer server. The address book lists participants homed on peer servers beside local ones, with their Squadron and nothing more; the envelope names the sender and its Squadron as it always has; no agent tool takes, returns or reveals a server. Where a Squadron lives is a fact the platform knows and the client shows when it matters, never a fact an agent manages.

**A person stays server-local.** A person's participant, their asks, and their inbox belong to each server they use; an ask to a person is delivered on the sender's own server, and the person's view of several servers is the client's merge described above. Peering carries messages between agents, and nothing else.

Delivery across peer servers is the same delivery with one more step: the send is a ledger row on the sender's server, the peer server records its own received row, and that acknowledgement is the sender's delivery receipt. Across servers the receipt means the peer server accepted and recorded the message; delivering it into the agent's thread is then the peer server's own delivery, which retries and alarms there, attributed to the sender as any delivery is. Failure to reach the peer server retries and alarms on the sender's server as any failure does. Everything that flows back — a reply, a silence notice, a lifecycle closure — travels the same path in reverse, which is why peering is mutual: one Exchange needs both directions. Peer servers reach each other directly at the recorded origin; a relay or tunnel is never a required part of it.

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

11. A server delivers to, and accepts deliveries from, only the servers in its peer registry; a peer record names the peer server's environment id, the origin this server reaches it at, the credential the peer server issued and when it expires.
12. Peering is mutual: the client records each environment as the other's peer server in one introduction, and removing either side ends delivery in both directions. An introduction that fails partway stops and reports each step; it leaves any credential it issued unused and the other side's existing credential working, so a retry or a removal clears the half-recorded state.
13. A peer server's credential is an ordinary session of the issuing server, bound to the peer server's environment identity and to a scope that permits only accepting deliveries and reading the address book; it appears in Settings → Connections. It is long-lived rather than renewed, and the holder's record shows when it expires. When it is revoked or has expired, the holder's deliveries are refused and alarm with that reason, the issuer's record shows the peer server without a live session, and the address book reports it as unread, never omitted.
14. Peering is done from a client connected to both environments with administrative scope; the person confirms the origin each server will use, which may differ from the one the client uses.
15. A peer server is recorded only after the recording server has reached it at the stated origin with the credential it issued; an unreachable origin is refused with the reason, never recorded, and a known peer server is not moved to a new origin unless the person says so.
16. An agent addresses a participant homed on a peer server by the same participant id it would use locally; no agent verb takes, returns or reveals a server, and the envelope names the sender and its Squadron exactly as for a local send.
17. The address book lists participants homed on peer servers beside local ones with their Squadron; it reads every peer server's roster live on each call, so an unreachable one costs the call its timeout and is reported as unread in the listing, never omitted silently.
18. A message to a participant on a peer server is recorded in the sender's Squadron ledger before the call returns, for a participant the address book resolves or one this server has already exchanged messages with; a first message to a participant on a peer server that cannot be read is refused with the reason. The peer server records its own received row before delivering to the agent's thread, and that acknowledgement is the sender's delivery receipt: it means the peer server accepted the message, and delivery into the thread is the peer server's to retry and alarm on. Failure to reach the peer server retries and alarms on the sender's server as any delivery does.
19. Retrying one message to a peer server never yields a second received row or a second delivery.
20. A reply, silence notice, withdrawal or lifecycle closure for an Exchange across peer servers travels the peer path back to the origin server and closes or notifies the origin Exchange exactly as a local one would; a withdrawal closes the Exchange without waking the answerer, locally or across servers.
21. A person is never addressed across peer servers: an ask to a person is delivered on the sender's own server.
22. Peer servers reach each other directly at the recorded origin; no relay or tunnel is required for peering.

## Scenarios

- **Two servers, one inbox.** The user's client connects to the work server and the home server. An ask from an agent in Billing Migration (work) and one from Support Rotation (home) appear in one inbox, each tagged with its environment; answering each reaches the right server. (AC2, AC3)
- **A server goes dark.** The home server is asleep; its rows stay on the Fleet page with "as of 40m ago" and never vanish. (AC4)
- **One server is read-only.** The user's connection to the home server has no operate scope: its Squadrons and asks appear in the merged lists, and the answer box for a home-server ask explains that this connection cannot reply. (AC8)
- **Peering two servers.** The user opens Settings → Connections on their laptop, connected to the work server and the home server, and peers them. Each server confirms it can reach the other at the origin the user confirmed; each lists the other as an authorized session. Revoking either session later ends the peering, and removing the peer from Settings removes it on both servers when the client can manage both, or says which server still lists the other when it cannot. Peering is managed from the web and desktop clients; the mobile client does not manage it. (AC11–AC15)
- **A Mac-only job.** An agent that must run on a Mac gets its own Squadron homed on the Mac server. An agent in Billing Migration, on the work server, asks it for results by participant id, as it would ask any participant; the ask is recorded in Billing Migration's ledger, the Mac server records its received row and delivers it, and the reply travels back and closes the Exchange. Neither agent named a server. (AC1, AC6, AC16, AC18, AC20)
- **The home server is asleep.** An agent on the work server asks an agent homed on the home server that it has messaged before. The send is recorded from the route the ledger remembers, delivery retries and then alarms on the asker, and the work server's address book reports the home server as unread rather than showing nobody there. A first message to an agent the work server has never seen is refused while the home server cannot be read, naming that as the reason. (AC17, AC18)

## History

- 2026-08-19 — the position settled with Jackson: authority never replicates; former X1–X5 (this file's earlier form was the register). Grounded in the remote-hosting research and the A2A design.
- 2026-09-12 — the Squadron picker, the sidebar's Squadron scope and the inbox merge every connected environment on web and desktop, with labels only when needed, read-only connections, incomplete counts and unsupported servers stated (PR #125, issue #105); AC7–AC10 added.
- 2026-09-10 — rewritten into the definition shape. Former identifiers: X1 → AC1; X2 → AC2; X3 → the sequencing sentence in the first capability row; X4 → the peer-registry paragraph, AC6; X5 → the client-pulled backup paragraph. Personal deployment details (which server is where) removed from the definition.
- 2026-09-16 — peering defined: mutual peer records introduced by the client, ordinary sessions on the receiving side, Squadron-resolved routing invisible to agents, people server-local, no relay or tunnel; AC6 rewritten from a deferral into a criterion; AC11–AC22 and three scenarios added ([record](../worklog/2026-09-16-cross-server-peering-session.md)).
- 2026-09-24 — review of the peering definition against the implementation (PR #172): "peer server" is the term for another server, leaving "peer" to mean another agent; AC12 states what a failed introduction leaves; AC13 covers a credential's expiry and revocation; AC17 states the live roster read and its cost; AC18 and the asleep-server scenario state that the receipt means acceptance by the peer server and that only known participants get the record-retry-alarm path; AC20 names withdrawal.
- 2026-09-24 — review of the Connections UI (PR #177): removing a peer is mutual when the client can manage the other server and states the remaining step when it cannot; peering is managed from web and desktop, not the mobile client.
