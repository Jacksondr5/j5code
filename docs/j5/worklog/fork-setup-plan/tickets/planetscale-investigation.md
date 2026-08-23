---
title: "T4 — PlanetScale / relay investigation"
kind: ticket
status: 2
---

# T4 — PlanetScale / relay investigation

**Goal:** confirm (or refute) that PlanetScale is exclusively the relay Worker's database and that skipping the relay costs us nothing we currently want; assess a local-friendly port for later. Research ticket — no code changes.

## Scope

- Read `infra/relay` end to end at the pin: the Worker, its PlanetScale schema and every query, the Alchemy deployment definition, the Clerk integration.
- Confirm by search that nothing outside the relay path (server, clients, desktop) reads/writes PlanetScale or requires a deployed relay — i.e., with `T3CODE_*` relay config unset, no code path is degraded except T3 Connect itself.
- Enumerate exactly which user-facing capabilities are lost with no relay (internet access without VPN, presumably mobile-from-anywhere) and confirm Tailscale/SSH paths cover Jackson's multi-machine use.
- Assess a self-hosted-friendly port for the future: could the Worker run on Cloudflare D1 or plain SQLite/Postgres? Note schema features that would block it (e.g., MySQL-isms), and rough effort.
- Deliverable: sub-artifact `../relay-assessment.md` with a **keep / skip / port-later** recommendation and the evidence.

## Out of scope

Deploying anything. Porting anything. Clerk evaluation beyond its role in the relay.

## Dependencies

None (reads the pinned source; can run from any clone/worktree). Independent of T1–T3.

## Acceptance

`../relay-assessment.md` exists with the query/schema inventory, the lost-capability list, the port assessment, and a recommendation Jackson can act on in one read.
