---
kind: spec
title: "Remote hosting review — J5 server on corporate Azure"
---

# Remote hosting review — J5 server on corporate Azure

**Question:** can the inherited T3 remote/server capability host the J5 work fleet on a headless Linux box in a corporate Azure tenant ("dv" nonprod subscription), reached over plain HTTPS on the corporate network from the work laptop — and what does a hybrid local+remote setup cost?

**Evidence tagging convention used throughout:** `[code]` = verified by reading source with file:line (upstream worktree `pingdotgg/t3code` @ `c9063f03e`, fork `jacksondr5/j5code` — v2 base @ `e7597dac8`, J5 A1/A2 layer read from the `origin/j5/main` ref @ `fdd04688c`); `[doc]` = claimed by upstream docs, not independently executed; `[artifact]` = claimed by a prior research artifact. The upstream `docs/user/remote-access.md` was verified byte-identical between the local worktree HEAD and `origin/main` (2026-08-18) via `git diff`, so the local copy is the current upstream doc.

---

## Verdict: **yes, with caveats — and none of the caveats are code blockers**

The use case works. Load-bearing evidence:

1. **The desktop client connects to any HTTPS URL with just a host + pairing token.** The bearer path has no allowlist, no relay dependency, no localhost assumption: `resolveRemotePairingTarget` accepts `http/https/ws/wss` and coerces a bare host to `https://` (`packages/shared/src/remote.ts:6, :85-87`), and `preparePairingRegistration` does a descriptor fetch + local token exchange against that base URL (`packages/client-runtime/src/connection/onboarding.ts:86-119`). The desktop Settings → Connections "Add Environment" dialog exposes exactly this (host + pairing-code fields, `apps/web/src/components/settings/ConnectionsSettings.tsx:2406-2434, :3377-3401`). `[code]`
2. **The server runs headless on Linux as a pure Node process** (`t3 serve`, `apps/server/src/cli/server.ts:26-36`; no Electron dependency in `apps/server`; engines `^22.16 || ^23.11 || >=24.10`), with a real systemd user-service installer (`t3 service install`, `apps/server/src/cli/service.ts:74-201`, unit rendered by `apps/server/src/cloud/bootService.ts:53-84`, `loginctl enable-linger` at `:342`). `[code]`
3. **Auth is fully local — no Clerk, no relay.** Pairing tokens, RFC 8693 token exchange, sessions, and 5-minute WebSocket tickets are all implemented against the server's own SQLite (`apps/server/src/auth/EnvironmentAuth.ts:655-744`, `apps/server/src/auth/http.ts:200-333`, contract `packages/contracts/src/environmentHttp.ts:410-446`). The fork's zero-cloud configuration only disables the `t3 connect` relay path (`apps/server/src/bin.ts:46-58`, `cloud/publicConfig.ts:211-215`); `pair` and `auth` are registered unconditionally. `[code]`
4. **The fleet genuinely runs server-side with no client attached.** Provider turns are durable outbox effects executed by a server-forked worker (`orchestration-v2/EffectOutbox.ts:26-62`, worker forked at `serverRuntimeStartup.ts:297-319, :491`); startup recovery reconciles the outbox and provider runs (`ProviderRuntimeRecoveryService.ts:474-515`); scheduled tasks fire from a 5-second server poll with restart recovery (`scheduledTasks/ScheduledTaskService.ts:665-670, :640-663`). `[code]`

Caveats (detailed in Gaps): the server terminates **plain HTTP only** — HTTPS requires a reverse proxy in front (fits the "routed like other nonprod apps" assumption); the corporate L7 path **must pass WebSocket upgrades** (no fallback transport exists); the TLS cert must chain to a CA in the laptop's OS trust store (no in-app override); provider CLI credentials must be provisioned on the box once; and a server restart **terminalizes** in-flight turns rather than resuming them mid-stream.

One finding that *changes* the hybrid question: the premise that "a client connects to ONE environment at a time" (from the synthesis artifact `[artifact]`) is **not true of the current code**. The client runtime connects to **all saved environments concurrently** and the sidebar aggregates threads, attention pills, and projects across them (`packages/client-runtime/src/connection/registry.ts:346-361`; below). Hybrid local+remote is a first-class single-pane experience at the T3 layer; the real seams are all in the J5 squadron layer, which is strictly per-server-database.

---

## Part A — Deployment feasibility (code-verified)

### A1. What the self-hosted server mode actually is

- `t3 serve` = the same server as the desktop backend, started with `startupPresentation: "headless"` — it prints a connection string, one-time pairing token (5-min TTL, `auth/PairingGrantStore.ts:241`), pairing URL, and QR code (`startupAccess.ts:122-131`, driven from `serverRuntimeStartup.ts:408-413`). `[code]` (Matches `docs/user/remote-access.md` Option 2 `[doc]`.)
- **Flags** (`apps/server/src/cli/config.ts`): `--host` (:29-32, env `T3CODE_HOST`), `--port` (:24-28, env `T3CODE_PORT`, default 3773), `--base-dir` (:33-38, ≡ `T3CODE_HOME`), positional `cwd`, `--no-browser`, `--tailscale-serve[-port]`. `[code]`
- **State**: default base dir `~/.t3` (`os-jank.ts:105-110`); runtime state under `<baseDir>/userdata` (`config.ts:99-133`): `state.sqlite`, `secrets/` (0700, `auth/ServerSecretStore.ts:158-169`), `environment-id`, `attachments/`, `logs/`, `settings.json`; plus `<baseDir>/worktrees` and `<baseDir>/caches`. `[code]`
- **systemd**: `t3 service install|status|update|uninstall` renders a user unit at `~/.config/systemd/user/t3code.service` (`bootService.ts:28-29`), `Restart=always`, launcher-indirection with DB snapshot before remote update candidates, `loginctl enable-linger` so it survives logout (`bootService.ts:336-342`; launcher spawns `serve` at `serviceLauncher.ts:402`). `[code]` The doc's claims (`docs/user/background-service.md`) are backed by code, **except** one gap: the generated unit sets only `T3CODE_HOME` — no host/port (`bootService.ts:64-65`), so a service-installed server binds loopback unless `T3CODE_HOST` is injected (see Gaps).
- **Pure Node, but not dependency-free**: native modules `node-pty`, `msgpackr-extract`, `@ff-labs/fff-node`, plus the Rust `resource-monitor` — relevant to container-vs-VM choice. `[code]`

### A2. Direct addressing — the connection path

- Target taxonomy: `Primary | Bearer | Relay | Ssh` (`packages/client-runtime/src/connection/model.ts:9-54`). A corporate server is an ordinary **BearerConnectionTarget**; URLs live in a `BearerConnectionProfile`, token in a `BearerConnectionCredential` (`onboarding.ts:100-117`). Proven by test: host `remote.example.test` + code → `https://.../` + `wss://.../` with exactly two HTTP calls, `/.well-known/t3/environment` and `/oauth/token` (`onboarding.test.ts:81-107`). `[code]`
- **Transport = plain HTTP (fetch) + one WebSocket.** No HTTP/2, no SSE, no long-poll fallback anywhere in the client transport (repo-wide grep negative). RPC socket: `Socket.layerWebSocket(connection.socketUrl)` with `retryTransientErrors: false` (`rpc/session.ts:95-103`) — if the WS upgrade fails there is no fallback, only supervisor backoff. `[code]`
- WS URL is a pure protocol swap from the HTTP base (`shared/advertisedEndpoint.ts:42-46`, `shared/remote.ts:106-130`), path forced to `/ws` (`authorization/remote.ts:186-188`; server route `apps/server/src/ws.ts:2286-2293`). The client also forces `pathname = "/"` on base URLs — **the server must own its origin; a sub-path mount will not work** (`remote.ts:100`, `rpc/http.ts:89-95`). `[code]`
- Endpoints the corporate route must serve on one origin: `GET /.well-known/t3/environment`, `POST /oauth/token`, `POST /api/auth/session`, `POST /api/auth/websocket-ticket`, `GET /ws` (upgrade). `[code]`
- **Supervisor behavior** (matters behind corporate idle-timeout proxies): retry ladder 3/4/8/16s capped at 16s forever for transient failures (`supervisor.ts:32, :104-106`), ladder reset after 30s stable (`:36`), auth failures block until an external signal rather than retrying (`:703-720`). A proxy that idles out the socket costs at most a ~16s reconnect. `[code]`

### A3. What the relay provides, and the bypass

The relay is discovery + credential brokering + managed Cloudflare tunnel + mobile push (APNs/Live Activities) — a control plane, never the data plane `[artifact: relay-assessment, remote deep-dive]`. Bypass is clean and code-verified in the fork:

- `hasCloudPublicConfig` requires relay URL + Clerk publishable key + Clerk CLI OAuth client id, all absent in the fork (env and build-time; no `.env` exists, J5 CI injects nothing) (`apps/server/src/cloud/publicConfig.ts:211-215`). `[code]`
- When false: startup cloud-link reconcile short-circuits before any relay dial (`server.ts:560-565` in fork); only `connect` is stubbed out in the CLI — `pair`/`auth`/`serve`/`service` are unconditional (`bin.ts:53-58`); web/mobile hide cloud UI. **Nothing in the bearer pairing/connection path reads any cloud config.** `[code]`

### A4. Auth for a self-hosted endpoint

Fully local, capability-scoped, and the setup UX is one command:

- `t3 pair` mints a one-time pairing token in-process against the local DB and prints URL + QR (`cli/pair.ts:435-456, :484-541`); `t3 auth` is explicitly "Manage the local auth control plane for headless deployments" — `pairing create|list|revoke`, `session issue|list|revoke`, works with no server running (`cli/auth.ts:29-51, :243-246`; proven in `bin.test.ts:329-412`). `[code]`
- Exchange: one-time bootstrap token → RFC 8693 token exchange at `POST /oauth/token` (`contracts/auth.ts:113, :176-178`) → 30-day bearer session (`SessionStore.ts:403`), or DPoP-bound 1-hour token if the client presents a proof (`EnvironmentAuth.ts:709`; optional, `auth/http.ts:279-290`). WebSocket connect uses a 5-minute single-purpose ticket in `wsTicket` (`SessionStore.ts:404`; client `authorization/remote.ts:131-191`). Per-RPC scope enforcement via `RPC_REQUIRED_SCOPES` (`auth/RpcAuthorization.ts`). `[code]`
- Setup UX end-to-end: run server → `t3 pair` on the box → paste URL (or host+token) into desktop Add Environment → done. Re-issue/revoke later with `t3 auth`. `[code]`

### A5. TLS

- **The server has no TLS.** Listen is `NodeHttp.createServer` / Bun on `config.host ?? "127.0.0.1"` (`server.ts:187-213`); repo-wide grep for `https.createServer`/`node:tls`/cert options in the server is negative. HTTPS comes from whatever sits in front (reverse proxy, corporate L7, or Tailscale Serve — which itself just shells out and proxies to loopback, `packages/tailscale/src/tailscale.ts:346`). `[code]`
- **The client relaxes nothing.** Zero hits for `rejectUnauthorized`, `certificate-error`, `ignore-certificate-errors`, `NODE_EXTRA_CA_CERTS`, `setCertificateVerifyProc` across the repo; Electron windows are hardened (`contextIsolation`, `sandbox`, `DesktopWindow.ts:347-354`); CSP deliberately allows any `http:/https:/ws:/wss:` host (`ElectronProtocol.ts:79-83`). All environment traffic originates in the renderer (global `fetch`/`WebSocket`, `apps/web/src/lib/runtime.ts:19, :60`), so cert validation is Chromium's against the **OS trust store**. A corporate-internal-CA cert works iff the corp CA is in the laptop's OS store (standard on managed laptops); a self-signed cert cannot be clicked through. `[code]`
- **Prefer HTTPS over plain HTTP for the desktop too**: the desktop app scheme is registered `secure: true` (`ElectronProtocol.ts:112-131`), and code-level analysis says a plain `http://` bearer target would be mixed-content-blocked in that renderer (`advertisedEndpoint.ts:48-57` classifies `http:` as `mixed-content-blocked` for hosted HTTPS). The upstream doc claims direct `http://` LAN pairing works from the desktop `[doc]` — this contradiction was **not resolved empirically**; since the corporate route is HTTPS anyway, treat HTTP-from-desktop as unsupported. `[code + doc, unresolved]`
- No localhost hardcoding on the bearer path (grep negative in `client-runtime`); loopback logic exists only for primary-target resolution and QR display (`apps/web/src/environments/primary/target.ts:76`). `[code]`

### A6. Fleet continuity, scheduled tasks, providers on headless Linux

- **Server-owned runs**: provider work is persisted as effect rows (`provider-turn.start|interrupt|steer|restart`, `EffectOutbox.ts:26-62`) in `orchestration_v2_effect_outbox` (migration `043_OrchestrationV2Foundation.ts:110-127`), claimed by a worker fiber forked during startup (`serverRuntimeStartup.ts:297-319, :491-493`). `ws.ts` is a pure subscribe/dispatch transport — no client-count gating anywhere. `[code]`
- **Startup reconciliation**: `ProviderRuntimeRecoveryService.recover` runs as ordered startup phase `orchestration-v2.recovery` before the worker starts (`serverRuntimeStartup.ts:490`), reconciling projections and the outbox (`ProviderRuntimeRecoveryService.ts:474-515`; outbox side `EffectOutbox.ts:433-464`). **Semantic caveat:** recovery is *reconcile-to-terminal* — nonterminal runs are terminalized and process-bound effects cancelled ("Cancelled because the server process ended…"), with only the replay-safe subset requeued (`EffectOutbox.ts:436-459`). Threads survive restarts consistently; an in-flight provider turn does not resume itself. `[code]`
- **Scheduled tasks fire clientless**: `scheduled_tasks` table (migration `048_ScheduledTasks.ts:8-41`), 5-second forked poll (`ScheduledTaskService.ts:665-670`), interrupted-run recovery on restart (`:640-663`), firing path is a direct server-side `threadLaunch.launch` (`:482`). Schedule kinds are `interval` and `fixed_time` + weekday mask (not cron); missed fixed-time runs beyond a 10-min grace are skipped forward, not fired late (`Schedule.ts:70-85`). `[code]`
- **Providers**: fork compiles six drivers (`builtInDrivers.ts:49-56`), with Codex and Claude the configured day-one pair `[artifact: backlog #1]`. Codex spawns `codex app-server` with `CODEX_HOME` injected (`CodexAdapterV2.ts:1279-1286`); Claude goes through `@anthropic-ai/claude-agent-sdk`, which spawns the resolved `claude` binary, isolated via `CLAUDE_CONFIG_DIR` (never `HOME` — explicit comment that changing `HOME` breaks OAuth credential lookup, `ClaudeHome.ts:27-33`). **There is no in-app provider OAuth flow**; the server's posture when unauthenticated is literally "Run `codex login` and try again" (`CodexProvider.ts:496`). Credentials therefore live in the provider CLIs' own state on the server box (`~/.codex/auth.json` — treated as private, `CodexHomeLayout.ts:32`; Claude's config dir). `[code]`
- **Headless login reality** *(general knowledge, not code-verified — the T3/J5 code never performs logins)*: Codex headless provisioning is straightforward (copy a valid `auth.json` into `CODEX_HOME`, or API-key login). Claude Code login is an OAuth flow normally involving a browser; on a headless box plan for one interactive SSH session (URL-paste flow), a long-lived token, or `ANTHROPIC_API_KEY` via the provider's env-var settings (the J5/T3 settings UI supports per-provider sensitive env vars, `docs/user/providers-claude.md` `[doc]`). Verify token/refresh longevity in practice — flagged under Gaps.

---

## Part B — Hybrid local+remote consequences

### B1. The "one environment at a time" premise is stale — the client is multi-environment concurrent

Code contradicts the synthesis note `[artifact]`:

- On boot the registry starts supervisors for **all persisted environments in parallel** (`registry.ts:346-361`, `Effect.forEach(..., { concurrency: "unbounded" })`) and every created scope immediately connects (`registry.ts:247-271`); test "starts persisted environments independently" (`registry.test.ts:461-487`). Nothing in app code ever calls `supervisor.disconnect` — teardown paths are destructive removal only. The client even reports activity to every environment every 25s (`apps/web/src/lib/backgroundActivityReporter.ts:193-208`). `[code]`
- **There is no environment switcher.** Environment is a route segment (`/_chat/$environmentId/$threadId`); "switching" is clicking a thread in a sidebar that already aggregates every environment. Thread list, project list, search, and the PR page all iterate all catalog environments (`packages/client-runtime/src/state/threadShell.ts:150-173`, `projectEntities.ts:72-102`, `threadSearch.ts:46-79`); project groups merge the same logical repo across environments into one row (`projectGrouping.ts:122-141, :290-334`). The only picker is per-draft "Run on" among environments hosting the same logical project (`BranchToolbarEnvironmentSelector.tsx:75-124`). `[code]`
- **You DO see the other environment's attention state**: `hasPendingApprovals`/`hasPendingUserInput`/`hasActionableProposedPlan` ride each thread's shell record (`contracts/orchestration.ts:460-468`) and render as sidebar status pills with rollup priority regardless of which environment you're viewing (`Sidebar.logic.ts:120-145`). A disconnected environment still shows cached threads ("cached" state, `state/shell.ts:44-48, :100-107`). `[code]`
- What you do **not** get anywhere (even single-environment): desktop OS notifications. No Electron `Notification`, no badge, no sounds — grep negative across `apps/desktop` and `apps/web`; push exists only on mobile via the (skipped) relay/APNs pipeline. `[code]` So "see the fleet from away" means opening the app (which works from anywhere on the corp network), not being pinged.
- The fork's v2-based web app has the same cross-environment sidebar (composite `${environmentId}:${projectId}` keys, `j5code/apps/web/src/components/Sidebar.tsx:615, :930, :1857`). `[code]`

**Consequence: a hybrid setup is one window, two servers, both live.** The costs are not UX-switching costs; they are the J5-layer partition below, plus double state (two SQLite DBs, two sets of provider credentials, two versions to keep in sync — version skew is surfaced per-environment in Settings `[doc: updating.md]`).

### B2. J5 squadrons are strictly server-DB-scoped — verified on `origin/j5/main`

*(Stale-checkout trap, worth recording: the live clone's HEAD sits at the old pin `e7597dac8` where `apps/server/src/j5/` contains only the fleet-load harness — a first verification pass concluded "the squadron layer does not exist." `origin/j5/main` (`fdd04688c`) already has A1 (#4), A2, and the squadron rename (#8) merged: +5,204 lines under `apps/server/src/j5/a2a/`. All claims below were re-read from the ref with `git show`. This is exactly the verify-worktree-freshness failure mode from earlier field notes.)*

- **Storage:** the A2A ledger lives in the server's own `state.sqlite` — `runJ5A2AMigrations()` is invoked from the server's SQLite layer (`apps/server/src/persistence/Layers/Sqlite.ts:42`), with a deliberately separate tracking table `j5_a2a_migrations` so upstream rebases can't skip J5 migrations (`j5/a2a/Migrations.ts`). Tables after migration 003: `j5_a2a_squadron`, `j5_a2a_comm_event (squadron_id, seq PK)`, `j5_a2a_comm_command_receipt`, `j5_a2a_squadron_membership`, `j5_a2a_exchange`, `j5_a2a_delivery (…, receiver_squadron_id)`, `j5_a2a_human_inbox_data (origin_squadron_id)` (`migrations/001…003`). `[code]`
- **No cross-server anything, and no hidden single-host-for-all-squadrons assumption either.** Grep across every `j5/a2a` file on the ref for `environmentId|hostname|remote` is empty — the layer has no concept of hosts at all. Receiver resolution is a membership lookup in the local DB that fails closed with `A2AParticipantNotFoundError` (`SendService.ts:218, :226, :331`); cross-**squadron** sends are same-DB ledger-to-ledger (receiver ledger records `message.received` durably before transport is attempted — `j5/a2a/README.md`). MCP tools (`send_message`, `list_participants`) fail closed without a locally provisioned home-squadron membership (`README.md`). `[code]`
- **Confirmed consequence:** a squadron cannot span local+remote, and neither can a cross-squadron exchange — both ends must live in one server's DB. **Hybrid = each squadron wholly local or wholly remote**, and additionally *any two squadrons that need to talk must be co-located*. The failure mode for addressing a participant on the other server is a clean typed error, not corruption. The practical partition rule: co-locate by communication cluster, not just by squadron.
- One v2-base hazard to keep in mind (not a hybrid blocker, a "never share a DB" rule): startup reconciliation sweeps the entire DB with no scoping and ignores `lease_owner` (`EffectOutbox.ts:433-464`, `ProviderRuntimeRecoveryService.ts:474-511`) — two server processes pointed at one `state.sqlite` would trample each other on every boot. One box, one base dir, one server. `[code]`

### B3. Dashboard and human inbox under hybrid

`j5_a2a_human_inbox_data` is a per-server table written by the local `DeliveryTransport` (`DeliveryTransport.ts:157`), and T3's own dashboard-shaped projection (`getShellSnapshot` → `ws.subscribeShell`) is likewise per-environment (`orchestration-v2/ProjectionStore.ts:106, :2529`; `ws.ts:746`). So with two servers there are **two inboxes and two dashboard projections; nothing server-side aggregates, by design**. The seam for backlog item 5: T3 already demonstrates the client-side answer — the sidebar merges per-environment subscriptions into one view (`threadShell.ts:150-173`, `projectGrouping.ts`), so a J5 inbox/dashboard built as *client-runtime atoms over per-environment streams* would be hybrid-correct for free, while one built as a server-side projection consumed from a single environment would silently show half the fleet. Flagging only; not designing it here.

### B4. Item 5 inventory (transport reuse for cross-server A2A)

T3 hands item 5 a nearly complete server-to-server substrate: the bearer target + local capability auth means server A could hold a scoped 30-day session on server B exactly the way a desktop client does (RFC 8693 exchange, per-RPC scopes, 5-minute WS tickets, optional DPoP — all cloud-free), the connection supervisor/registry already manages N concurrent authenticated peers with correct backoff/blocked semantics (`registry.ts`, `supervisor.ts`), the Effect RPC contract layer (`WsRpcGroup`) gives typed streams for a future `a2a.deliver` method gated by a new scope in `RPC_REQUIRED_SCOPES`, and J5's own ledger already provides the idempotent durable-acceptance semantics (`message.received` receipts, attempt-stable message ids) that a store-and-forward cross-server hop needs; on a flat corporate network no relay/tunnel piece is required at all.

---

## Deployment sketch (corporate Azure tenant, dv subscription)

Stated assumption: the box is routed like any other nonprod internal app — a corporate DNS name, TLS terminated by corp-standard means (L7 gateway or on-box proxy) with a corp-CA cert, reachable only on the corporate network. No public exposure, no Tailscale, no SSH tunneling.

- **VM over container.** Ubuntu LTS VM. The server is pure Node but carries native modules (`node-pty`, `msgpackr-extract`, `@ff-labs/fff-node`) plus provider CLIs (`codex`, `claude`), git, and a persistent mutable state/worktree tree — a systemd VM is the shape the upstream code already targets (`t3 service` exists; no Dockerfile does). Node per engines: `^22.16 || ^23.11 || >=24.10`.
- **Process management:** `t3 service install` (systemd user unit + linger, auto-restart, update-with-DB-snapshot). **Required extra step:** the generated unit sets no host, so either inject `T3CODE_HOST` (`systemctl --user edit t3code` drop-in) or skip `t3 service` and write a plain unit running `t3 serve --host 127.0.0.1 <workdir>`.
- **Bind loopback, proxy in front.** `--host 127.0.0.1` + nginx/caddy on the box (or the corp L7 gateway pointing at the VM) terminating TLS with the corp-CA cert and proxying to `127.0.0.1:3773` **with WebSocket upgrade headers and a generous read timeout** (an idle-killed socket costs a ≤16s reconnect, but avoid the churn). The server must be the origin root — no `/j5` sub-path. Verify early that the chosen corp routing tier passes WS upgrades; that is the single most likely environmental failure.
- **State & backup:** `T3CODE_HOME=/srv/j5/t3home` (or default `~/.t3`). Back up `<home>/userdata` (SQLite + `secrets/` + `environment-id`) plus `<home>/worktrees` if agent work-in-progress matters; use SQLite online backup or stop-the-service snapshots (the service launcher already snapshots the DB around updates). Provider credential dirs (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`) belong in the backup set too.
- **Pairing:** on the box run `t3 pair` (note: with a wildcard bind the persisted origin collapses to `127.0.0.1` — `serverRuntimeState.ts:41-48` — so bind a concrete host or just type host+token manually in the desktop dialog, which sidesteps the printed URL entirely). Tokens are 5-minute one-time; later issuance/revocation via `t3 auth`.
- **Client:** work-laptop desktop app → Settings → Connections → Add Environment → `https://j5.<corp-internal-domain>` + pairing code. The corp CA is already in the managed laptop's OS store, which is all Chromium needs. Keep the local and remote servers on the same J5 build to avoid version-skew friction.
- **Providers:** one-time provisioning on the VM — `codex login` (or copy `auth.json`) and `claude auth login` via an interactive SSH session (or API-key env vars on the provider instance). Per-account isolation via `CODEX_HOME` / `CLAUDE_CONFIG_DIR` exactly as on the laptop.

---

## Gaps and risks

| # | Item | Kind | Size |
|---|------|------|------|
| 1 | **No TLS in server** — needs proxy/gateway in front | infra only; matches corp routing anyway | 0 code |
| 2 | **WS upgrade through corporate L7** — no fallback transport exists (`session.ts:101`) | environmental risk; test first | 0 code; a spike hour |
| 3 | **systemd unit lacks host/port** (`bootService.ts:64-65`) | ops workaround (drop-in env) or J5 patch to unit rendering | ~10-line patch, optional |
| 4 | **`t3 pair` prints loopback URL after wildcard bind** (`serverRuntimeState.ts:41-48`) | ops workaround (concrete `--host`, or manual host+token entry) | 0–small |
| 5 | **Restart terminalizes in-flight turns** (reconcile-to-terminal, `EffectOutbox.ts:436-459`) — fleet continuity means durable state + scheduled/queued work, not mid-turn resume | accept; document for fleet ops | 0 now |
| 6 | **Claude headless login** — no in-app auth; OAuth on a headless box unverified end-to-end; token/refresh longevity unknown | must validate on the VM before committing | spike; env-var/API-key fallback exists |
| 7 | **No desktop OS notifications at all** — remote activity is visible only in-app (sidebar pills) | product gap; feeds J5 item 4 (dashboard/inbox) anyway | medium feature if wanted |
| 8 | **Mobile visibility = none** without relay (push is relay/APNs-only); non-corporate devices are excluded by policy anyway | accept | 0 |
| 9 | **Squadron partition rule** — a squadron *and its exchange partners* must be co-located per server; misaddressing fails clean (`A2AParticipantNotFoundError`) | J5 ops convention now; item 5 later | 0 code now |
| 10 | **Two inboxes/dashboards** under hybrid until item 5; build the future inbox/dashboard as client-side per-environment aggregation, not a single-server projection | design constraint to record | 0 now; saves a rewrite later |
| 11 | **Never point two servers at one state dir** — whole-DB startup sweeps ignore lease ownership (`EffectOutbox.ts:433-464`) | hard rule | 0 |
| 12 | Plain `http://` from desktop possibly mixed-content-blocked (doc says it works; code analysis suggests not) — moot under HTTPS | unresolved; low relevance | 0 |
| 13 | Corp-VM trust: `state.sqlite` and provider tokens are unencrypted at rest under a 0700 dir; box admins can read them | governance note for a work fleet | 0 code |

## Item 5 inventory

See B4 (kept to one paragraph). Short list: bearer targets + local capability auth as server-to-server credentials; the supervisor/registry multi-peer connection machinery; Effect RPC contracts + per-method scopes for a future `a2a.deliver` surface; J5 ledger receipts for idempotent store-and-forward; no relay needed on a flat corporate network.
