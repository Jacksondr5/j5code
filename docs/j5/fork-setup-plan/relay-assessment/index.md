---
title: "Relay and PlanetScale assessment"
kind: spec
---

# Relay and PlanetScale assessment

**Source reviewed:** `77168d081abbdd7522f90b3b204cc693015d5f26` (`t3code/codex-turn-mapping`), including all runtime sources, migrations, deploy definition, and client/config call sites. This is a source assessment, not a deployed-system inspection.

## Recommendation — skip now; port later only if we choose T3 Connect

Do **not** deploy `infra/relay`, PlanetScale, Clerk, Cloudflare relay resources, APNs, or relay tracing for the initial J5 Code fork. PlanetScale is exclusively the relay control-plane database at this pin. With the public relay/Clerk configuration absent, T3 Connect UI and CLI paths intentionally disable; normal local/LAN/Tailscale connections and desktop SSH-managed connections remain independent.

If we later need the product-managed, internet-facing T3 Connect experience, port the database abstraction as part of a deliberate relay deployment project. A generic Postgres target is the lowest-risk port; D1 is feasible but requires a real dialect/driver and migration rewrite; a plain local SQLite database requires moving the Worker to a long-running Node-compatible host (or choosing an HTTP-accessible SQLite/libSQL service). The database change alone does **not** make the relay self-hosted: the current Worker also depends on Cloudflare Workers, Queues, Tunnel/DNS bindings, Clerk, APNs, and Axiom.

## Scope finding

The name is slightly misleading: this is **PlanetScale Postgres**, not the older PlanetScale MySQL pattern. `src/db.ts` creates a `Planetscale.PostgresDatabase` named `t3coderelay`; the production stage retains it, while non-production stages use a PlanetScale branch and runtime role. The Worker reaches it through Cloudflare Hyperdrive and `@effect/sql-pg` / Drizzle Postgres. `alchemy.run.ts` is the only stack that registers the PlanetScale provider.

A pinned-tree search for `planetscale`, excluding vendored Alchemy sources and the lockfile, found operational use only in:

- `infra/relay/{alchemy.run.ts,src/db.ts,README.md}` and relay deployment CI;
- relay architecture/release documentation; and
- the marketing privacy-policy disclosure that describes it as the T3 Connect database.

No server, web, desktop, mobile, contracts, or ordinary persistence code imports a PlanetScale client or queries this database. The workspace catalog entry is the relay stack's dependency, not evidence of a second runtime consumer.

## What the relay stores and queries

All ten tables belong to the relay's three functions: account-to-environment control plane, managed Cloudflare tunnels, and mobile activity delivery/security. There are no application projects, threads, provider sessions, or local T3 state tables here.

| Table | Writes / reads | Relay function |
| --- | --- | --- |
| `relay_environment_links` | upsert, active-list/get, soft-revoke; joins to credentials/activity/tunnel counts | Maps a Clerk user to a signed environment and advertised endpoint |
| `relay_environment_credentials` | insert then revoke prior credentials; hash lookup with `EXISTS` active-link check; conditional revoke with `NOT EXISTS` | Authenticates an environment back to the relay |
| `relay_managed_endpoint_allocations` | reserve/upsert-like claim, record tunnel/DNS, optimistic generation updates, conditional delete | Tracks Cloudflare Tunnel and DNS allocation lifecycle |
| `relay_managed_tunnel_limits` | per-user override lookup plus joined active-tunnel count | Limits hosted managed tunnels (default three) |
| `relay_dpop_proofs` | insert-on-conflict replay nonce, expiry delete | One-time DPoP / link challenge replay protection |
| `relay_mobile_devices` | claim globally unique push tokens, per-device upsert/list/delete | iOS registration and notification preferences |
| `relay_live_activities` | register/upsert, delivery-state update, target listing/delete | APNs Live Activity token and lifecycle state |
| `relay_agent_activity_rows` | upsert/remove, user-scoped joined list, terminal JSON-state prune | Temporary per-thread state for notification aggregates |
| `relay_delivery_attempts` | insert, idempotency claim/reclaim, completion update | APNs delivery deduplication and diagnostics |
| `relay_migrations` | Drizzle/Alchemy migration ledger | Schema deployment bookkeeping |

The endpoint-level health route is simply `SELECT 1`; all other database access is contained in `infra/relay/src/{auth,environments,agentActivity}`. The Worker constructs every persistence layer in `src/worker.ts`; no other process has a database binding.

## What we lose by never deploying it

We lose **T3 Connect**, the hosted convenience/control plane, rather than the direct T3 Code data plane. The relay README explicitly says normal API and WebSocket traffic goes directly between a connected client and the selected environment; the relay is not in that hot path.

| Lost without relay | What that means |
| --- | --- |
| Cloud-account sign-in and linked-environment discovery | No Clerk-backed list of environments shared across web/mobile/desktop clients |
| `t3 connect` linking and short-lived relay-issued connection credentials | No cloud-mediated environment enrollment or DPoP connection/status minting |
| Managed public endpoint | No relay-provisioned Cloudflare Tunnel, custom DNS hostname, or hosted per-user tunnel limit |
| Mobile relay features | No environment activity publication to relay, APNs notifications, or Live Activities |
| Relay-only tracing | No Axiom relay/client trace configuration |

This does not block Jackson's intended initial path: local usage, LAN/pairing, Tailscale HTTPS/Serve, and the desktop's SSH-managed connection path are implemented independently. The web/mobile cloud components gate on a complete trio of Clerk publishable key, Clerk JWT template, and secure relay URL; without them they return no onboarding/sign-in/cloud-link UI. The server similarly computes `hasCloudPublicConfig` as false, so its `t3 connect` cloud command path is not enabled. This is graceful feature omission, not a partially configured relay call.

## Port-later assessment

| Target | Feasibility | Required work / caution |
| --- | --- | --- |
| Generic Postgres | **Best later option** | Keep the existing Postgres schema and most query code; replace PlanetScale provisioning, role/branch lifecycle, and Hyperdrive-specific wiring with a standard connection strategy appropriate to the chosen host. The code already uses `@effect/sql-pg` and `drizzle-orm/pg-core`. |
| Cloudflare D1 | **Feasible, moderate rewrite** | Replace `@effect/sql-pg`, Hyperdrive, `pgTable`, and Postgres migrations with D1/SQLite equivalents and bind D1 in the Worker. Port `jsonb` to text/JSON, PostgreSQL JSON extraction (`state_json ->> 'phase'`), `pg-core` `QueryBuilder`, and verify every `RETURNING`, `ON CONFLICT`, `excluded`, `coalesce`, join, and transaction path against D1. The unlink flow requires a real atomic transaction for link revocation plus credential revocation. |
| Plain SQLite | **Feasible only with a host change** | The present Cloudflare Worker has no filesystem database binding. Run the relay as a Node/Bun service with an SQLite Effect/Drizzle driver, or use a remote SQLite-compatible service. It inherits the D1 dialect rewrite but also replaces Worker/queue/cron infrastructure. |

The SQL is mostly portable relational SQL, with conflict upserts, conditional updates/deletes, joins, and `RETURNING`. The three concrete Postgres-specific points above are why this is not a configuration switch. No schema feature appears to require PlanetScale itself, and the persisted state is modest enough that a fresh migration is preferable to cross-provider data import for a personal relay.

## Evidence map

- Infrastructure: `infra/relay/alchemy.run.ts`, `src/db.ts`, `src/worker.ts`, `src/queues.ts`, `scripts/deploy.ts`, and `README.md`.
- Schema/migrations: `infra/relay/src/persistence/schema.ts` and `infra/relay/migrations/postgres/`.
- Database access: `src/auth/DpopProofs.ts`; `src/environments/{EnvironmentLinks,EnvironmentCredentials,ManagedEndpointAllocations,ManagedTunnelLimits}.ts`; and `src/agentActivity/{AgentActivityRows,Devices,LiveActivities,DeliveryAttempts}.ts`.
- Feature gates and independent alternatives: `apps/{web,mobile}/src/cloud/publicConfig.ts`, `apps/server/src/cloud/publicConfig.ts`, `apps/server/src/bin.ts`, and `apps/web/src/components/settings/ConnectionsSettings.tsx`.
