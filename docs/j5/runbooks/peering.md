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

1. **On Home**, issue the credential Work will present when it delivers to Home. Work's environment id comes from `j5 a2a peer credential --for ... --json` on Work, or from the client.

   ```sh
   j5 a2a peer credential --for <work environment id> --label Work --credential-only > work.credential
   ```

   The credential is a session in Home's auth database with subject `peer:<work environment id>` and the single scope `a2a:peer`. It appears in Settings → Connections as `Peer: Work`. Issuing again for the same environment revokes the earlier one.

2. **On Work**, record Home, proving the credential at Home's origin:

   ```sh
   j5 a2a peer add --peer-origin https://home.example:3773 --credential-file work.credential --label Home
   ```

   Work calls Home's hello route with the credential. It records the peer only if Home answers, the credential names Work, and Home is not Work itself. An unreachable origin exits 6 and records nothing; a credential issued for a different environment exits 5.

3. **On Work**, issue Home's credential the same way, and **on Home**, add Work. One Exchange needs both directions, so peering is incomplete until all four steps have run.

## Inspecting and ending peering

- `j5 a2a peer list` prints one line per peer: environment id, label, origin, recorded at.
- `j5 a2a peer remove --environment <id>` deletes this server's record of the peer and revokes the session that peer held here. Delivery ends in both directions from this server's point of view; run it on the other server too to clean up its side.
- Revoking the `Peer: …` session in Settings → Connections has the same effect on inbound delivery as `remove`; the stale record on the other server then fails delivery with an alarm rather than silently.

## Exit codes

The `peer` verbs use the same codes as the rest of `j5 a2a` ([machine senders](machine-senders.md)). Two are worth knowing here: 6 means the local server or the peer origin could not be reached, and 5 means the peer refused the pairing by policy (the credential was issued for another environment, or the origin is this server).
