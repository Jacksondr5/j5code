---
title: "Cross-server peering session (2026-09-16)"
kind: record
---

# Cross-server peering session (2026-09-16)

Jackson, working from a remote development server inside J5, asked whether the A2A implementation could deliver between servers and, if not, what it would take. The outcome is written into [cross-device](../product/cross-device.md) (the Peering section, AC6 and AC11–AC22), with one-line touches in the [A2A definition](../product/a2a/index.md), the [agent tools](../product/a2a/agent-tools.md) and the [glossary](../product/glossary.md). This record is the story and the build outline.

## What the investigation found

The implementation at `f54635303` is strictly single-server:

- Receiver resolution in `apps/server/src/j5/a2a/SendService.ts` reads only the local membership, machine and person tables; an unknown id fails as not found, with no remote fallback.
- The cross-Squadron path is already two writes — the sender's `message.sent` and the receiver Squadron's `message.received`, appended by the delivery worker — but both land in the same SQLite. The two-write shape was chosen in August so that a remote receiver could exist; it never had one.
- The delivery transport injects through the in-process orchestrator. No outbound network step exists.
- No peer concept exists anywhere in the server or the contracts. The only server-to-server trust is the T3 Connect relay, which brokers client bootstrap and carries no application traffic.
- Ids are mostly portable: Squadrons are `squadron:<uuid>`, agents are `agent:j5:a2a:<threadId>`. Person ids are minted per server and machine names are only server-unique.

One degenerate cross-server path exists today: the machine-sender HTTP surface from #144. A script on server A can `j5 a2a send --origin <server B>` with a token B issued, and the message lands attributed to a `machine:` participant registered on B. One direction, plain messages only, no Exchange, not reachable from an agent's `send_message`.

## Jackson's questions and rulings

**"Do we need a peer registry if we already have the remote connections list?"** The connections list is client-only — `packages/client-runtime/src/connection/catalog.ts` holds environment id, label and base URLs, with the token in the client's credential store. A server knows only its own environment id and the sessions it has issued. So something server-side is new, but it extends what exists rather than adding a concept: on the receiving side a peer is an ordinary issued session with a peer subject and scope, visible and revocable in Settings → Connections like a paired device or a machine token; on the sending side the new record is small — the peer's environment id, a reachable origin and the token. The client, the one party connected to both servers with administrative scope, performs the introduction. Ruled: yes, expand on the existing pieces this way.

**"Do we need to expose the origin or environment to agents, or is it encapsulated by the Squadron?"** Encapsulated. Squadron and agent ids are already unique across servers; the routing fact the platform needs is which peer hosts a Squadron, and it can learn that from the peers' own address books. `send_message` keeps a bare participant id, `list_participants` merges peer rows with their Squadron and no server field, and envelopes are unchanged because they already name sender and Squadron. Ruled: agents and the CLI never manage a target server.

**Scope.** Relay and tunnel transports are out; peers reach each other directly. People remain server-local; the inbox merge already covers the person. The trigger the 2026-08-19 position waited for has arrived: Jackson already runs a remote development server and works from it.

## Build outline

Not a plan — sequencing and issues come later — but the shape agreed in the session, so the definition's criteria can be read against it:

1. **Contracts.** A peer scope beside `a2a:send` in the upstream scope list (FORK.md case 35 precedent), kept out of both client bundles. A peer session's subject is `peer:<environmentId>`.
2. **Server state.** One peer table (environment id, origin, token, created at) and a receiver-environment column on the delivery row. Both in the J5 migration lane.
3. **Routes.** A receive route that accepts a sent message plus origin environment, writes the receiver Squadron's `message.received` row idempotently on origin plus message id, and hands off to the existing worker. The existing roster route serves the peer's address-book read under the peer scope.
4. **Resolution.** On a local miss, the send service asks each peer's roster live and records receiver Squadron plus peer on the delivery row. No persistent Squadron-to-peer cache: peers are few and a live read is never stale. Two peers claiming one Squadron id is the existing ambiguous-participant refusal.
5. **Transport.** A remote branch in the delivery transport that posts to the peer; the peer's receipt is `message.delivered`; failure flows into the existing retry, backoff and alarm path unchanged.
6. **Return traffic.** Replies, silence notices and lifecycle closures originate on the receiving server and travel the same path back. This is where the bugs will hide.
7. **Introduction.** A "Peer with…" action in Settings → Connections on web and desktop that mints both sessions, lets the person confirm each server's origin, and has each server verify reachability before recording. A `j5 a2a peer` CLI for the same, for headless hosts.
8. **Client.** Environment labels on remote-origin rows where the client already labels by environment; nothing new for agents.

Excluded from the first cut, by the rulings above: asks to a person across peers, relay or tunnel transport, machine participants sending to remote agents (the machine-sender path already covers that case).
