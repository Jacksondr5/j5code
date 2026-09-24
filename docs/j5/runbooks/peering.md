---
title: "Peering — connecting two J5 servers with `j5 a2a peer`"
kind: runbook
---

# Peering

How an operator records two J5 servers as each other's peers so their agents can exchange messages. The behavior is defined in [cross-device](../product/cross-device.md) (Peering); this page tells an operator what to type. The web app's Settings → Connections offers the same steps in one action when a client is connected to both servers; the CLI is for headless hosts and scripts.

Peering is mutual and pairwise. Each server ends up holding two things: a credential the other server issued to it, and a record of where the other server is reached. Nothing about how agents address each other changes; a participant on a peer is addressed by the same id as a local one.

## Vocabulary

- **Work** and **Home** below are the two servers. Every step names which host it runs on.
- **Environment id** is a server's stable identity, printed by `j5 a2a peer credential` and shown by the client in Settings → Connections.
- **Origin** is the URL one server reaches the other at. It is not necessarily the URL your laptop uses: a loopback or SSH-forwarded address that works for the client does not work between servers.

## Peering two servers

Run each pair of steps on the named host. Every command talks to the local server; run on the server host it needs no token (a temporary local admin session is minted and revoked). From elsewhere, pass `--token` with an `access:write` token.

1. **On Work**, read Work's environment id: `j5 a2a peer identity` prints it (it reads the public environment descriptor and needs no token; Settings → Connections shows the same id). Then **on Home**, issue the credential Work will present when it delivers to Home:

   ```sh
   j5 a2a peer credential --for <work environment id> --label Work --credential-only > work.credential
   ```

   The credential is a session in Home's auth database with subject `peer:<work environment id>` and the single scope `a2a:peer`, valid for ten years so peering never lapses quietly; Home's record of the peer shows when it expires. It appears in Settings → Connections as `Peer: Work`. Issuing again for the same environment does not revoke the earlier credential yet: the earlier one is revoked when Work proves the new one at Home's hello route (step 2), so a rotation that stops halfway leaves Work able to deliver.

2. **On Work**, record Home, proving the credential at Home's origin:

   ```sh
   j5 a2a peer add --peer-origin https://home.example:3773 --credential-file work.credential --label Home
   ```

   Work calls Home's hello route with the credential. It records the peer only if Home answers, the credential names Work, and Home is not Work itself. Re-adding a known peer rotates its credential; re-adding it at a different origin is refused unless you pass `--replace-origin`, because hello proves the origin is reachable, not that it is the same server.

3. **On Work**, issue Home's credential the same way, and **on Home**, add Work. One Exchange needs both directions, so peering is incomplete until all four steps have run.

## Inspecting and ending peering

- `j5 a2a peer list` prints one line per peer: environment id, label, origin, recorded at, whether the peer still holds a live session here (`inbound: active` or `inbound: no live session`), and when the credential it issued us expires.
- `j5 a2a peer remove --environment <id>` deletes this server's record of the peer and revokes the session that peer held here. Delivery ends in both directions from this server's point of view; run it on the other server too to clean up its side. Open Exchanges with agents on that server are not closed by removal: a later reply or follow-up to one fails delivery and alarms, and the answerer's silence detector keeps measuring the debt. Close or withdraw them first, or archive the agents involved, if you want them settled (tracked in issue #286).
- Revoking the `Peer: …` session in Settings → Connections ends inbound delivery from that peer: its deliveries are refused and alarm on its side. This server's own record and outbound delivery are untouched until you `remove` the peer; `peer list` shows the peer as `inbound: no live session` meanwhile.

## Exit codes

The `peer` verbs use the same codes as the rest of `j5 a2a` ([machine senders](machine-senders.md)). Three are worth knowing here: 6 means the local server or the peer origin could not be reached, or the peer rejected the credential (HTTP 502 `peer_credential_rejected`); 5 means the peer refused the pairing (the credential names another environment, or the peer is already recorded at a different origin); 2 means the request was invalid, including an origin that is this server itself.
