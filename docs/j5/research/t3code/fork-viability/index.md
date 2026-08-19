---
title: "Fork viability: T3 Code as foundation"
kind: spec
---

# Fork viability: T3 Code as foundation

**Re-assessment under Jackson's framing:** _fork the codebase as a foundation for adding multi-agent orchestration_, not _fork the product including its cloud_.

<user_quoted_section>Bottom line up front: Jackson is right, and my earlier verdict was weak.
It rested on two things. The first — operational inheritance (relay, Clerk, APNs, release infra) — he correctly identifies as swappable cost, and the code confirms the swap is much cheaper than I implied. The second — "the orchestration core is the part you'd have to rewrite anyway" — I asserted without verifying. Having now verified it: it is largely false. Three of the four capabilities he wants are additive against the existing grain, and one of them is already built.
Revised recommendation: fork, with a specific discipline (§6). The real risks are different from the ones I named.</user_quoted_section>

<user_quoted_section>⚠️ Superseded on fork point — see §7 Timing.§6 recommends forking main. That was written believing no v2 roadmap existed. It is wrong: orchestration-v2 is a ~230-commit, Shape-4.5-complete rewrite on origin/t3code/codex-turn-mapping that hard-cuts v1. Fork the v2 branch, not main. §1–§5 hold; §6's discipline holds; only the fork point changes. §7 also retires the load-test gate — v2 fixes the single-fiber queue.</user_quoted_section>

## 1. Infra swap audit

### Verdict: cleaner than I claimed. Jackson's (a)–(d) all hold.

All cloud configuration flows through **one loader** — `scripts/lib/public-config.ts` — with documented precedence: process/CI env → `.env.local` → `.env`. It projects seven canonical `T3CODE_*` values into framework-specific `VITE_*` and `EXPO_PUBLIC_*` aliases so no downstream package reads raw config.

The entire cloud surface is these values:

```dotenv
T3CODE_CLERK_PUBLISHABLE_KEY      # pk_live_... (public identifier, not a secret)
T3CODE_CLERK_JWT_TEMPLATE         # t3-relay
T3CODE_CLERK_CLI_OAUTH_CLIENT_ID  # public OAuth client id
T3CODE_RELAY_URL                  # https://relay.t3.codes
T3CODE_HOSTED_APP_URL             # optional, defaults to https://app.t3.codes
T3CODE_MOBILE_OTLP_TRACES_{URL,DATASET,TOKEN}   # optional, ingest-only
```

`.env.example` states outright: _"These are the same public identifiers baked into official release builds, not secrets. Remove or comment them out to build with cloud features disabled."_

**Critically: absent config degrades, it does not break.** From `docs/internals/t3-connect.md` — _"When any client-facing public value is absent, cloud UI is omitted."_ And the `t3 connect` command group is still registered, with a hidden fallback command that reports the missing configuration rather than silently vanishing from help. So a fresh clone with no `.env` is a fully working local/LAN/Tailscale/SSH product with the cloud paths cleanly switched off.

### Per-item swap effort

| Item                  | What's actually hardcoded                                                                                                                                                                                                                                                                                                                                   | Real effort                                                                                                                                                                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) Relay**         | Nothing in app code. `infra/relay` is 78 files deployed by Alchemy reading `RELAY_DOMAIN`, `RELAY_API_ZONE_NAME`, `RELAY_TUNNEL_ZONE_NAME`, `CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_AUDIENCE` via Effect `Config`. **"There are no checked-in deployment defaults."** `vp run --filter t3code-relay deploy` auto-writes the deployed URL back into root `.env`. | **Low.** Needs a Cloudflare account + PlanetScale. Note the prod Alchemy stage owns the retained PlanetScale DB and non-prod stages branch from it — so deploy `prod` first. A day, mostly waiting on DNS/zone setup.                                                                 |
| **(b) Clerk**         | Only the publishable key, JWT template name, and CLI OAuth client id — all env. Setup is documented step-by-step: create the `t3-relay` JWT template with `{"aud":"t3-code-relay"}`, create a **public** OAuth app with PKCE, add two redirect URIs (`http://127.0.0.1:34338/callback` and `<hosted>/connect/callback`), enable `openid`/`profile`/`email`. | **Low.** Jackson has a tenant. Half a day of dashboard work following `t3-connect.md`. One gotcha the docs flag: omitting the hosted callback URI silently breaks headless and SSH authorization.                                                                                     |
| **(c) APNs**          | Certs/keys are relay-side runtime config (`ApnsProviderTokens`, `apnsJwt`). Nothing baked into app code.                                                                                                                                                                                                                                                    | **Low–medium.** Standard Apple Developer work. Only needed if we want push + Live Activities, which are relay-dependent anyway. Deferrable.                                                                                                                                           |
| **(d) Release infra** | `DESKTOP_APP_ID = "com.t3tools.t3code"` in `scripts/build-desktop-artifact.ts`; `com.t3tools.t3code{,.dev,.preview}` in `apps/mobile/app.config.ts`; `t3code://app` / `t3code-dev://app` custom schemes, including in the server's `DESKTOP_RENDERER_ORIGINS` CORS allowlist (`apps/server/src/http.ts:45`).                                                | **Low if skipping.** Personal-first means `vp run dev` and an unsigned local desktop build. Renaming bundle IDs is a ~6-site find-and-replace, but do it _early_ — macOS caches Shared Web Credentials per app/version pair, and passkey/associated-domain config is bundle-ID-bound. |

### Hardcoded URL inventory (complete)

Only five string literals across all non-test source: `https://app.t3.codes` (`DEFAULT_HOSTED_APP_URL` in `packages/shared/src/connectAuth.ts:17`), `nightly.app.t3.codes`, `latest.app.t3.codes`, `//t3.codes` and `//t3.codes/schema/t3.json`. All are defaults behind env overrides or marketing/schema references. **There is no hidden telemetry endpoint and no hardcoded update feed** — desktop updates resolve from GitHub Releases via the release workflow, and the OTLP tracing config is optional, ingest-only, and env-driven.

### Dependencies Jackson didn't list

1. **Cloudflare Tunnel + a pinned managed `cloudflared` binary** — installed by `t3 connect link`. A Cloudflare account is required for the relay path (not just Workers — the tunnel hostnames too).
2. **PlanetScale** — the relay's persistence (`infra/relay/src/persistence/schema.ts`, `db.ts`, `dbConfig.ts`). Swappable in principle (it's MySQL-shaped through Effect SQL) but it's a real second vendor.
3. **Alchemy** — the IaC tool. Vendored as a reference repo (`.repos/alchemy-effect`), which suggests it's young. Deploy tooling is a dependency, not just a convenience.
4. **Expo / EAS** — three mobile workflows (`mobile-eas-preview`, `mobile-eas-production`, `mobile-fingerprint-check`). Skippable while personal-first; an EAS account when not.
5. **Axiom** — the default OTLP traces destination in the example config. Optional.
6. **`.repos/` sync** — `vpr sync:repos` vendors upstream sources; the workflow assumes network access to those repos.

None of these are blockers. (1) and (2) are the only ones that cost money, and only for the relay path.

**§1 conclusion: Jackson's assumptions hold. Total infra swap is on the order of 2–4 days, most of it vendor-account setup rather than code.** I overstated this.

## 2. Entanglement analysis — the crux

### How deeply is one-thread-one-agent assumed?

**The literal assumption is small and localized.** In `packages/contracts/src/orchestration.ts`, `OrchestrationThread` carries exactly one:

```ts
session: Schema.NullOr(OrchestrationSession);
```

One session per thread. `ProviderService` routes by thread → session; the projector maintains it. That is the one-thread-one-agent model, and it is one field.

**But here's what changes the picture entirely: T3 already runs N agents under one thread.** Subagents and workflows are _not_ sessions. They arrive as `thread.activity.append` commands carrying `TaskAgentLinkage`, and are folded into a roster. So the fleet already lives in the activity stream, not the session model. **T3's data model does not actually assume one agent per thread — it assumes one _provider session_ per thread, with arbitrarily many agents beneath it.**

That is a much weaker constraint than I implied, and it is the single most important correction to my earlier verdict.

### Aggregate extensibility

The entire aggregate taxonomy is three things:

1. `OrchestrationAggregateKind = Schema.Literals(["project", "thread"])` — one line, `orchestration.ts:1077`.
2. `commandToAggregateRef` — an **18-line switch** in `OrchestrationEngine.ts:59–77`, with a `default:` returning `{aggregateKind: "thread", aggregateId: command.threadId}`.
3. `OrchestrationReadModel = {snapshotSequence, projects[], threads[], updatedAt}` — a flat struct.

The decider (1,402 lines) is a **flat switch over ~40 command types**. The projector (806 lines) is a **flat switch over 30 event types**. Both are append-friendly: adding cases doesn't perturb existing ones, and each case is independently testable.

### Per-capability blast radius

| Capability                                                       | Verdict                                         | Blast radius                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **(i) Epic container** grouping threads + terminals + artifacts  | **Additive**                                    | New `epic` aggregate kind (1 literal), ~4 new cases in `commandToAggregateRef`, new command/event pairs in `decider.ts`, new cases in `projector.ts`, a new `epics[]` array on `OrchestrationReadModel`, one new `ProjectionEpics` service, one migration, new client atoms. Terminals are already thread-scoped (`packages/contracts/src/terminal.ts` keys everything by `threadId`), so epic→thread→terminal composes. **No existing event vocabulary changes.** Estimate: 1–2 weeks.                                                                                                                                                                                                                                                                |
| **(ii) Peer A2A broker with MCP surface**                        | **Mostly already built**                        | `apps/server/src/mcp/` ships a working authenticated MCP server: `McpHttpServer.ts` (provider-scoped bearer credentials, `invalid_mcp_credential` 401s, `www-authenticate`), `McpSessionRegistry`, `McpInvocationContext`, `McpProviderSession`, and a **`toolkits/` pattern** already used to expose preview automation to agents (`PreviewAutomationBroker`, `toolkits/preview/{tools,handlers}.ts`). Adding an A2A toolkit means a new `toolkits/a2a/` directory following an existing, tested pattern. The message broker itself is a new aggregate + reactor. **This is the capability I most underestimated.** Estimate: 2–3 weeks.                                                                                                              |
| **(iii) First-class peer agents (spawn/configure/fork/archive)** | **Largely exists**                              | If a peer agent ≈ a thread, the lifecycle is _already shipped_: `thread.create` (spawn), `thread.meta.update` + `thread.runtime-mode.set` + `thread.interaction-mode.set` (configure), `thread.archive`/`unarchive`/`delete` (archive), and **fork is checkpoints** — `CheckpointStore` already captures hidden git refs per turn and `thread.checkpoint.revert` reverts both workspace _and_ provider conversation. Fork = create a thread seeded from another's checkpoint ref. Plus `pin`/`snooze`/`settle` give you fleet triage for free. What's genuinely missing is **addressability** (an agent identity that isn't a thread id) and **inbox semantics** — both of which are (ii). Estimate: 2–3 weeks on top of (ii).                         |
| **(iv) Cross-machine routing**                                   | **Against the grain — build above, not inside** | This is the one real conflict. `docs/internals/remote.md` states the invariant plainly: _"T3 has one runtime boundary… Remoteness is expressed at the connection layer, never by splitting the runtime."_ `RepositoryIdentity` exists but is documented as _"never for routing."_ A client holds a catalog and connects to **one environment at a time**; there is no cross-environment state sync, and the docs list richer multi-environment UI under unbuilt Future Work. Fighting this inside the server means contradicting the design's central premise. **The right move is a routing/registry layer _above_ T3 environments** — which is additive, and which we'd have to build in a greenfield too. Estimate: unchanged by the fork decision. |

**3 of 4 additive; 1 unaffected by the choice.**

### The global serialization point — the real risk

This one is genuine and I want to state it precisely.

`OrchestrationEngine.ts:303`:

```ts
const worker = Effect.forever(Queue.take(commandQueue).pipe(Effect.flatMap(processEnvelope)));
yield * Effect.forkScoped(worker);
```

**One unbounded queue, one worker fiber, all aggregates.** Every command — across every thread, every project — serializes through a single fiber, and each envelope performs a full SQL transaction (append events + apply projections + write receipt).

And every assistant delta is a command. `ProviderRuntimeIngestion.ts` dispatches `thread.message.assistant.delta` at lines 1137, 1204, 1669, 1680 (plus spill/flush/finalize variants). Fleet activity (`thread.activity.append`) goes through the same door.

Worse for our purposes, the single-fiber design is **load-bearing for correctness**, not just an implementation detail. From the engine's own comment:

<user_quoted_section>"A plain property read is a consistent, committed value — reassignment of commandReadModel is atomic on the single-threaded event loop."</user_quoted_section>

So you cannot simply partition the queue per-aggregate: the in-memory read model's atomicity depends on exactly one writer. Partitioning means either per-aggregate read models or a different concurrency discipline. **That is a real refactor of the most delicate file in the repo — not a config change.**

Mitigating facts, in fairness:

- Buffered assistant delivery exists precisely to cut delta volume (24k-char spill threshold), and `MAX_VISIBLE_WORK_LOG_ENTRIES = 1` caps work-log churn.
- T3 ships this to 100k+ users who run Claude Code subagent fan-outs today, so it is evidently adequate at current fleet sizes.
- The ceiling is **localized to one 343-line file**. If we hit it, we know exactly where to go.

**Assessment: a real ceiling, not a wall.** It's the thing most likely to force a hard refactor at fleet scale, and it should be load-tested early — spawn 30 agents, measure dispatch latency — before committing. But it is one file, and it is a problem we would eventually have to solve in a greenfield too.

## 3. Upstream tracking

### Velocity

| Window                | Commits                            |
| --------------------- | ---------------------------------- |
| Last 90 days          | **1,051**                          |
| Recent weeks (29–32)  | 116, 142, 150, 110 → **~130/week** |
| New migrations in 90d | 13                                 |

Contributors are concentrated: Julius Marminge 506, Theo Browne 161, then a long tail. Two people write ~63% of commits. Plus a `t3-code[bot]` with 34.

### Churn where it matters — the surprise

Aggregate velocity is intimidating, but per-file churn in the orchestration **core** is low:

| File                                      | Commits / 90d |
| ----------------------------------------- | ------------- |
| `apps/server/src/ws.ts`                   | **55**        |
| `packages/contracts/src/rpc.ts`           | **23**        |
| `packages/contracts/src/orchestration.ts` | **21**        |
| `ProviderRuntimeIngestion.ts`             | 14            |
| `orchestration/decider.ts`                | **11**        |
| `orchestration/projector.ts`              | **8**         |
| `Layers/OrchestrationEngine.ts`           | **3**         |
| `client-runtime/state/subagentRuntime.ts` | **2**         |

**The pure core is nearly static. The churn is at the edges** — `ws.ts` and `rpc.ts` grow because features get added, and `orchestration.ts` grows because schemas get added. Those are _append-heavy_ files, and appends merge far better than rewrites.

This substantially improves the tracking picture. If our additions are new aggregates in new files plus new switch cases, the recurring conflicts are: migration number collisions (13/90d — trivial renumbering), new cases landing near ours in the two big switches (mechanical), and `rpc.ts`/`ws.ts` method-list appends (mechanical).

**Realistic assessment: tracking is viable with a monthly-or-so rebase cadence, on release tags rather than `main`.** Not "hard-fork-and-freeze." I was wrong to imply otherwise.

The caveat is discipline-dependent: this holds only if we resist modifying the decider and projector in place. If we start rewriting existing cases, the calculus inverts.

### orchestration-v2 timing

Genuinely ambiguous, and worth naming honestly:

**Argument for waiting:** v2 replaces the client-side subagent fold with a server-side projection. That is precisely the subsystem we care most about. Forking now means either carrying `subagentRuntime.ts` (self-labelled _"when the v1 orchestrator is retired this file is deleted"_) or diverging exactly where upstream is about to move.

**Argument for forking now:** the v2 field names and transition semantics are already frozen — _"Field names and transition semantics copy the v2 stack (#4779) exactly so that swap is mechanical."_ So we can build against the v2 shape today and skip v1 entirely. And the `.plans/` directory shows this team runs big migrations as documented, phased cutovers (`14-server-authoritative-event-sourcing-cleanup.md`, `spec-1-1-cutover-plan.md`), so v2 will land as a coherent series we can rebase onto rather than a slow smear.

**My read: fork now, but build the server-side subagent projection ourselves rather than adopting the v1 fold.** We want a server projection regardless — it's the right architecture and it's where upstream is going. That converts the migration from a liability into a non-event.

There is no v2 roadmap in `.plans/` (it's a historical record, not forward-looking), so we cannot time this precisely. Don't block on it.

## 4. Effect-TS commitment

### On-ramp for agents: unusually good

This codebase is **built to be edited by agents**, and it shows:

- **`AGENTS.md`** (12.7 KB) — glossary, taste rules, "hit every surface" checklist, explicit failure modes, verification policy.
- **`.repos/effect-smol/LLMS.md`** (382 lines) — vendored Effect guidance agents are instructed to read _before writing Effect code_.
- **`oxlint-plugin-t3code`** — four architectural invariants enforced as lint (`no-global-process-runtime`, `no-manual-effect-runtime-in-tests`, `no-inline-schema-compile`, `namespace-node-imports`). Agents get mechanical feedback on style violations.
- **822 test files, ~1 line of test per 2 lines of source** — a real safety net for agent-driven change.
- **Consistent house style.** Logic/view splits (`*.logic.ts` + `*.logic.test.ts`), flat switches, per-domain projection services, `Effect.fn("name")` tracing wrappers. Highly pattern-matchable — an agent can read one adapter and write the next.
- **`.agents/`, `.claude/`, `.codex/`, `.cursor/` directories** already present.

This is a better agent on-ramp than almost any codebase of this size, and it directly serves Jackson's plan of having agents do the porting work.

### Dependency stability: the actual risk

This is where I'd push back, and it's a _different_ risk than the one I named before:

- **Effect is on `4.0.0-beta.103` — a prerelease**, catalog-pinned across every `@effect/*` package.
- **Effect itself is patched**: `patches/effect@4.0.0-beta.103.patch`, plus `@effect__vitest@4.0.0-beta.103.patch`.
- **15 patch files total**, including React Native internals (`react-native-screens`, `react-native-nitro-modules`, `expo-modules-jsi`, `@legendapp/list`, `@pierre/diffs`).
- Code imports from **`effect/unstable/ai`** and `effect/unstable/http` — explicitly unstable namespaces.
- Toolchain is Vite+ (`vp`), `@effect/tsgo`, `@typescript/native-preview`, pnpm 11, Node 24.

Beta-to-stable in Effect 4 will involve breaking changes, and we'd absorb them on upstream's schedule or our own. The patches mean we're already off the published artifacts.

**Honest framing:** this is a real risk, but it's a risk _T3 carries too_ — and they have two full-time maintainers absorbing it. If we track upstream, we largely inherit their fixes for free. If we hard-fork, we own it alone. **This argues for tracking, not against forking.** That's the opposite of what I said last time.

## 5. Middle paths

### (a) Fork-and-freeze the server as substrate; orchestration as a separate service over its WS protocol

**Cost:** Low initial. Our orchestration service becomes just another RPC client — it can already dispatch commands, subscribe to threads, and drive terminals through the documented contract.

**Benefit:** Clean boundary; upstream churn is irrelevant; we could even run against an unmodified T3.

**Why it fails:** The WS contract is **client-facing**, and client-dispatchable commands are deliberately a _subset_. `thread.message.assistant.delta`, `thread.session.set`, and `thread.turn.diff.complete` are internal, produced only by server-side reactors. Per-method scope enforcement (`RPC_REQUIRED_SCOPES`) is designed to prevent exactly the kind of privileged access an orchestrator needs. And the epic aggregate has nowhere to live — you'd end up maintaining a shadow data model outside the event log, which forfeits the event-sourcing guarantee that made T3 attractive.

**Verdict: attractive on paper, structurally wrong.** Good for a prototype; a dead end as architecture.

### (b) Vendor specific packages into a greenfield app

**Cost:** Medium-high, and front-loaded. `packages/contracts` (56 files) is genuinely portable. `packages/effect-acp` (21 files) is self-contained and immediately useful. But **provider drivers are not portable** — `CodexAdapter`, `ClaudeAdapter` et al. depend on `ProviderAdapter`, `ProviderInstanceRegistry`, `ChildProcessSpawner`, `ServerConfig`, `EventNdjsonLogger`, and the whole `ProviderRuntimeIngestion` normalization layer. Vendoring "just the drivers" means vendoring most of `apps/server`. `packages/client-runtime` (148 files) similarly assumes the full contract surface.

**Benefit:** No fork discipline needed; we own our tree.

**Why it's weaker than it looks:** You take the two easy packages and rebuild the hard part — provider integration, which is exactly what Jackson wants to _avoid_ rebuilding. And you lose the 822-test safety net for everything you didn't vendor.

**Verdict: viable for `effect-acp` alone if we go greenfield.** Not a substitute for the fork.

### (c) Full tracking fork

**Cost:** Rebase discipline. Given §3's churn data — core near-static, edges append-heavy — this is a monthly rebase against release tags, mostly mechanical conflict resolution.

**Benefit:** Everything. Five working provider integrations, the full remote stack, the MCP server, the read path, the connection supervisor, the test suite, and continued upstream fixes including Effect-beta churn absorbed by their maintainers.

**Verdict: best cost/benefit, conditional on discipline.**

### Comparison

| Path                              | Time to "Traycer-grade orchestration on T3 substrate"               | Ongoing cost           | Risk profile                                          |
| --------------------------------- | ------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------- |
| **Greenfield + port patterns**    | **6–9 months** (provider integration alone is months, ×5 harnesses) | None                   | Low risk, high cost, and we rebuild solved problems   |
| **(a) Freeze + external service** | 2–3 months to a prototype, then structural wall                     | Low                    | Forfeits the event log; dead-ends                     |
| **(b) Vendor packages**           | **5–8 months**                                                      | Low                    | Rebuilds the hard part anyway                         |
| **(c) Tracking fork**             | **2–3 months**                                                      | ~2–4 days/month rebase | Medium: queue ceiling, Effect beta, rebase discipline |

## 6. Verdict

### Recommendation: **fork it — a tracking fork with additive discipline.**

Jackson's reasoning is sound and my earlier verdict was not. The decisive evidence:

1. **Provider integration — the expensive, tedious, high-value part — is done five times over**, behind a clean adapter contract, with ACP already implemented for two harnesses and a mock agent for testing. This is genuinely months of work we don't repeat, and it's the part that never stops needing maintenance as CLIs drift.
2. **The MCP server already exists**, authenticated and toolkit-structured. Jackson's A2A broker has a home.
3. **Thread lifecycle already is agent lifecycle** — create/configure/archive/pin/snooze/settle, plus checkpoint-based fork. We're adding addressability and messaging, not a lifecycle.
4. **The orchestration core is nearly static** (3–11 commits/90d) while the edges append. Tracking is realistic.
5. **Adding an aggregate is a genuinely small change** — one literal, one 18-line function, two flat switches, one migration.
6. **The codebase is engineered for agent editing**, which is precisely our development model.

### The discipline that makes it work

This recommendation is **conditional**. Violate these and the calculus inverts:

- **Add, don't modify.** New aggregates in new files; new switch cases appended; new projection services alongside existing ones. Every in-place rewrite of an existing decider/projector case is future rebase pain.
- **Rebase on release tags, monthly.** Not `main`, not continuously.
- **Build the server-side subagent projection ourselves**, targeting the frozen v2 field names. Skip the v1 client fold entirely. This makes orchestration-v2 a non-event instead of a merge crisis.
- **Load-test the command queue in week one.** Spawn 30 concurrent agents, measure dispatch latency and SQL transaction throughput. This is the one finding that could still change the answer, and it's cheap to test before committing.
- **Rename bundle IDs immediately**, before any signed build or passkey work.
- **Keep cross-machine routing above the environment boundary.** Don't fight `remote.md`'s central invariant; build a registry/router layer over T3 environments.

### Reversible vs one-way doors

**Reversible:**

- Infra swap (env config; revert by changing `.env`)
- Relay/Clerk/APNs choices (all vendor-swappable)
- Tracking cadence — a tracking fork can _become_ a hard fork at any time, for free

**One-way, or expensive to reverse:**

- **Effect 4 beta commitment.** Adopting this codebase means adopting Effect, the beta pin, and 15 patches. Backing out means a rewrite. This is the single largest irreversible commitment and it should be made consciously.
- **Command queue partitioning**, if we hit the ceiling. Refactoring the single-writer invariant touches the most delicate file in the repo and diverges us permanently from upstream's engine.
- **Divergence debt.** Every in-place modification compounds. There's a point of no return where rebasing costs more than maintaining alone — discipline is what keeps us short of it.

**Notably: the fork itself is _not_ a one-way door.** That's the crux of the revised verdict. A tracking fork that goes badly degrades into a hard fork, which is exactly where the greenfield path starts — minus five working provider integrations. The downside is bounded; the upside is months.

### What I got wrong

For the record, so the reasoning is auditable:

- I weighted **operational inheritance** as a primary argument. It's a 2–4 day cost, mostly vendor setup, and the code is exemplary about keeping it in env config. Jackson called this correctly.
- I asserted that **"the product shapes diverge… that difference lives in the orchestration core — the part you'd have to rewrite anyway."** Having actually read the decider, projector, engine, and aggregate resolution: the core is a flat, append-friendly switch set with an 18-line aggregate mapper, and T3 already runs many agents under one thread. The divergence is additive.
- I cited the **Effect beta and toolchain** as reasons _against_ forking. They're reasons _for tracking_ — upstream absorbs that churn with two full-time maintainers, and a hard fork would leave us carrying it alone.
- I **missed the MCP server entirely** in the first pass, which is the closest thing in the repo to a pre-built A2A substrate.

The risks I named were mostly wrong. The real ones are the **global command queue**, the **Effect 4 beta commitment**, and **rebase discipline** — and only the first could still flip this decision.

## 7. Timing addendum: fork point vs orchestration-v2

_Added after a peer subagent surfaced PR #2829. Verified directly against `origin/t3code/codex-turn-mapping` @ `77168d081` (2026-08-14), 230 commits ahead of `main`, **6 behind** — reconciled daily._

My §3 claim _"no v2 roadmap exists in `.plans/` — don't block on it"_ was wrong. I checked `.plans/` on `main`, where it is a historical archive. The v2 plan lives **on the branch**. That is a research error, and it changes the fork point.

### 7.0 What the branch actually is

| Measure                              | Value                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------- |
| Diff vs `main`                       | **858 files, +175,901 / −83,159**                                      |
| Test files (branch vs main)          | **913 vs 822** (+91)                                                   |
| v2 test files                        | **67**, plus replay-backed fixtures                                    |
| Shape status (per `.plans/21-...md`) | **1, 2, 3, 4.0, 4.5 all "complete"**                                   |
| Blocking                             | Stage 5 (existing-user v1→v2 state migration), explicitly out of scope |

Shape 4.5's status line is unambiguous: _"complete. Production web and mobile now consume the scoped V2 projection directly, and the temporary Shape 4.0 parity facade, V1 client RPC surface, and V2 debug route have been removed."_

One nuance worth correcting in the peer's summary: Shape 3 did not delete the event-sourcing platform. Its status line reads _"removes the V1 agent runtime, **restores the existing application event-sourcing data plane, and installs V2 behind it instead of replacing it**."_ The cut is to the **agent runtime**, not the persistence architecture.

### 7.1 Fork point: **the v2 branch.** Not `main`. Not wait-for-merge.

#### The hard cut is surgical — measured, not assumed

| Subsystem                                | Files changed / total | Survives?                                 |
| ---------------------------------------- | --------------------- | ----------------------------------------- |
| `infra/relay`                            | **0 / 78**            | ✅ untouched                              |
| `packages/ssh`                           | **0 / 11**            | ✅ untouched                              |
| `packages/tailscale`                     | **0 / 5**             | ✅ untouched                              |
| `apps/server/src/terminal`               | **0 / 8**             | ✅ untouched                              |
| `apps/desktop/src/ssh`                   | **0 / 4**             | ✅ untouched                              |
| `apps/server/src/auth`                   | **1 / 18**            | ✅ ~untouched                             |
| `packages/shared`                        | 14 / 106              | ✅ mostly survives                        |
| `apps/server/src/mcp`                    | 17 / 26               | ⚠️ v2 adds the orchestration toolkit here |
| `apps/server` overall                    | **533 changed**       | ❌ rewritten                              |
| `apps/web` / `client-runtime` / `mobile` | 136 / 65 / 63         | ❌ cut over                               |
| `packages/contracts`                     | 34                    | ❌ new v2 contracts                       |

**The entire remote/auth/relay/terminal/SSH/Tailscale platform — the substrate that made this fork attractive — survives the hard cut untouched.** That is the "genuinely orthogonal" bucket, and it is large.

#### But our planned work is _not_ in that bucket

| Our work                    | Orthogonal?                                       | Fate if built on `main`                                                                   |
| --------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Epic aggregate**          | ❌ orchestration-adjacent                         | Built against a decider/projector/read-model that Shape 3 deletes. **Invalidated.**       |
| **A2A toolkit**             | ❌ lands in `apps/server/src/mcp` (17/26 changed) | Collides with v2's orchestration toolkit, and is largely **superseded** by it (§7.2).     |
| **Peer lifecycle**          | ❌ built on thread lifecycle                      | v2 replaces `Thread→Turn` with `AppThread→Run→RunAttempt→ExecutionNode`. **Invalidated.** |
| Infra swap, bundle rename   | ✅                                                | Survives any base.                                                                        |
| Cross-machine routing layer | ✅ (above the environment boundary)               | Survives any base.                                                                        |

**Essentially 100% of the orchestration work in my §2 estimate would be written against code upstream deletes.** Forking `main` now is the one option clearly ruled out.

#### Why the branch beats waiting — the decisive asymmetry

**Upstream's release gate is fresh-state-only. We are fresh-state.**

Stage 5 — migrating installations that already contain v1 threads — is the sole undecided blocker, and the plan is explicit: _"Shapes 4.0 and 4.5 target a fully working V2 application on fresh V2 state while preserving legacy rows and files untouched."_ T3 cannot ship v2 to 100k existing users without solving a data migration. **We have no users and no v1 data.** The thing blocking them is precisely the thing we do not need.

We can build on v2 _before upstream can ship it_, and the `LegacyV1ThreadImporter` (#4400) already on the branch means even the migration groundwork exists if we ever want it.

Supporting evidence: the branch is 6 commits behind `main` and reconciled daily; new features are landing directly on it (#5589 worktrees, #5544 thread handoff, #5499 session import, #5003 GitHub waitpoints), which is what a team does with a branch it considers the future, not a spike.

#### The real risk of forking the branch, and the mitigation

**Squash-merge risk.** If #2829 lands as a squash, our base commit vanishes from upstream history and rebasing becomes a manual replay rather than a clean rebase.

Mitigation, which is just §6's discipline applied earlier: keep our additions in **new files** (new aggregate, new toolkit, new projection). A squash merge is then survivable — we cherry-pick our own commits onto the new base. Rebase pain is proportional to how much we edited _existing_ files, which the discipline already drives toward zero.

#### Recommended sequencing — start now, absorb the merge as a small delta

| Phase                  | Base              | Work                                                                                                                                                                                                                                        |
| ---------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 (now, ~2–4 wks)**  | branch, read-only | Infra swap (§1), bundle rename, read the 9 `docs/orchestration-v2/` design docs, design epic + artifacts + roles against **v2 contracts**, prototype the A2A peer layer against the existing orchestrator MCP. Almost all base-independent. |
| **2 (on #2829 merge)** | merged `main`     | Rebase; build the orchestration-adjacent work — epic aggregate, peer semantics, roles — against a settled v2.                                                                                                                               |
| **3**                  | merged `main`     | Cross-machine routing layer above the environment boundary.                                                                                                                                                                                 |

This never writes a line against v1, starts immediately, and shrinks the merge to a small delta.

### 7.2 Overlap audit: v2's orchestrator MCP vs our A2A layer

Verified against `docs/orchestration-v2/orchestrator-mcp-server.md` on the branch. The overlap is **substantial** — considerably more than the peer's summary conveyed.

#### Free

- **`delegate_task`** — spawn an app-owned child agent on _any_ provider instance, durable result, optional `role` instruction in the same call. Notably: _"The child receives only the supplied task prompt… Parent conversation history is not copied into the child."_ That context-isolation decision is one we'd have had to make and get right.
- **`task_status` / `task_cancel`**, **`create_threads`**, **`t3_thread_start` / `list` / `read` / `send` / `wait` / `interrupt`**.
- **Send modes: auto / queue / steer / restart** — including steer-by-cancel-and-restart for providers without native steering. This is subtle, provider-specific work.
- **Scheduled tasks.**
- **`ThreadManagementService`** — a shared server application boundary for both WS commands and MCP, owning project-scoped lookup, send-mode selection, durable send postconditions, wait polling, interrupt selection. Transport adapters only authenticate and shape responses. This is exactly the layering we'd want, already built.
- **MCP injection into all five providers**, each done natively: Codex via `-c mcp_servers.t3-code.url` + `bearer_token_env_var`; Claude via `mcpServers` + `allowedTools: ["mcp__t3-code__*"]`; Cursor via SDK `mcpServers`; Grok via ACP `session/new`/`load`/`fork`. **This alone is weeks of per-harness work.**
- **Per-session scoped credentials** — scoped to environment + parent thread + provider instance + provider session; max-lifetime and idle expiry; revoked on session release; raw token never persisted in orchestration state.
- **Relationship graph** — environment-scoped, cycle-safe, with root/parent/child/fork/subagent/merge-back edges.
- **`ContextTransfer` / `ContextHandoff`** — powers fork, merge-back, provider switch, and device handoff.
- **Server-side `SubagentProjection`** — the thing `main`'s 940-line client fold exists to be deleted for. My §6 recommendation to "build the server-side subagent projection ourselves" is now **moot: it's built.**
- **ACP Registry driver** — a generic ACP flavor resolving agents from the official ACP Registry per platform. Harness breadth stops being a per-provider cost.

#### Still ours

- **Peer-to-peer messaging with typed silence.** v2's addressing is **hierarchical** — parent delegates to child, waits for a durable result. Traycer's model is peer↔peer with `expectReply` semantics and typed silence (a peer that processes without reporting back). `t3_thread_send` + `wait` is the right primitive, but the _addressing and reply-obligation model_ is ours.
- **Epic container + artifacts.** v2 has project→thread plus a relationship graph. No epic/story grouping, no artifact concept.
- **Roles as first-class.** v2's `role` is an optional instruction string on `delegate_task`. Traycer-grade roles — agent types with tool policies, model/effort defaults, a selection guide — are ours.
- **Cross-machine routing.** Still explicitly absent; still a layer above the environment boundary.

#### Effect on the estimate: **shrinks and shifts**

| Component                  | §2 estimate | Revised                                                             |
| -------------------------- | ----------- | ------------------------------------------------------------------- |
| A2A broker + MCP           | 2–3 wks     | **~1 wk** (peer semantics + typed silence on existing tools)        |
| Peer lifecycle             | 2–3 wks     | **~1 wk** (delegate/fork/relationship graph/context transfer exist) |
| Epic container + artifacts | 1–2 wks     | **2–3 wks** (artifacts added; no v2 equivalent)                     |
| Roles                      | folded in   | **~1 wk**                                                           |
| Cross-machine routing      | unchanged   | unchanged                                                           |

**Build effort: ~2–3 months → ~6–10 weeks.** But it is now **gated on the merge** for the orchestration-adjacent portion. Calendar time is roughly flat; delivered scope is materially higher, because we inherit delegation, steering, context transfer, and five-provider MCP injection rather than building them.

### 7.3 Stability read

**Coherent enough to build against. Credible self-report.**

- **913 tests** on the branch vs 822 on `main`; 67 v2 test files; replay-backed fixtures with named scenarios (`thread_fork_native_prior_turn`).
- **The TODO is honest, and that is the strongest credibility signal.** It carries genuinely unchecked boxes — projection rendering for rollback state, interrupt edge cases (_"provider emits chunks after interrupt requested"_), queue/steer projection tests — while marking five shapes complete. Aspirational plans don't leave specific boxes unticked; they claim uniform completion. The unchecked items are **projection-hardening edge cases, not core mechanics.**
- **Actively reconciled**: 6 commits behind `main`, latest reconcile 2026-08-14. New features landing on it directly.

**Caveats:** it is a draft PR at 858 files — review could still force changes; `Orchestrator.ts` is **7,253 lines**, a genuine maintainability concern and the single largest file in either tree; and Stage 5 remains undecided (irrelevant to us, material to upstream's timeline).

#### Does the single-fiber queue concern survive into v2? **No. It is fixed.**

This is the most consequential technical finding in this addendum. v2 replaces the global queue with per-identity locks:

```
apps/server/src/orchestration-v2/Orchestrator.ts:497
  const threadDispatch = yield* makeKeyedSerialExecutor<ThreadId>();
```

And `KeyedSerialExecutor.ts` states the intent exactly:

<user_quoted_section>"Serializes work that targets the same domain identity without coupling unrelated identities to a process-wide mutex."</user_quoted_section>

Implementation is a `Ref<Map<Key, {semaphore, users}>>` with refcounted acquire/release and `Effect.acquireUseRelease`. **Independent threads now dispatch concurrently; only same-thread work serializes.** The `commandReadModel`-single-writer coupling that made partitioning a deep refactor on `main` is gone.

Alongside it, **`EffectOutbox.ts`** (612 lines) makes side effects a **durable, SQL-backed, replayable queue** of typed requests (`provider-session.detach`, `provider-turn.start` / `interrupt` / `steer` / `restart`, …) rather than in-memory reactor subscriptions — with details like `revokeMcpCredential` on terminal detaches. Plus startup reconciliation that atomically cancels in-flight provider subtrees and resumes queued turns.

**Consequence: retire the week-one load test as a gating item.** My §6 gate was written against `main`'s architecture. It no longer describes the system we'd fork. Still worth running as validation once we're building — but it is no longer a decision input, and it was the only finding that could have flipped the fork recommendation.

### 7.4 Revised verdict

**Fork `origin/t3code/codex-turn-mapping`. Begin Phase 1 now. Rebase onto merged `main` when #2829 lands.**

The timing news is **net positive**, not a setback:

1. My single blocking technical risk is **solved upstream** (`KeyedSerialExecutor` + durable outbox).
2. The server-side subagent projection I recommended we build is **already built**.
3. Delegation, steering, context transfer, relationship graph, and five-provider MCP injection all arrive **free** — weeks of work we no longer do.
4. The platform substrate we wanted — relay, auth, SSH, Tailscale, terminals — is **provably untouched** by the cut.
5. Upstream's only release blocker is a migration **we structurally do not need**.

What actually changed: the fork point moves from `main` to the branch, the orchestration build waits on the merge, and the load-test gate retires. What holds: §1's cheap infra swap, §2's additive entanglement, §4's Effect-as-pro-tracking argument, §5's path comparison, and §6's add-don't-modify discipline — which matters **more** now, because it's also the squash-merge mitigation.
