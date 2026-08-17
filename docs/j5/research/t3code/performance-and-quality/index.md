---
title: "T3 Code — performance, quality & fork viability"
kind: spec
---

# Performance, quality & fork viability

## Why it feels fast — the short answer

Not one trick. Five layers of discipline, each with a named mechanism:

1. **Nothing unnecessary crosses the wire** (per-subscription streams, buffered delivery, snapshot-over-HTTP).
2. **Nothing unnecessary is read from the DB** (keyset-paginated windowed reads, purpose-built indexes).
3. **Nothing unnecessary repaints** (fixed-height rows, DOM-write timers, banned continuous animations, React excluded from terminal frames).
4. **Nothing unnecessary is polled** (drain/receipt-based async, event-driven telemetry, no sleeps).
5. **A written constitution** that names all of the above as non-negotiable, plus regular audits for regressions.

The AGENTS.md statement of intent:

<user_quoted_section>"Lots of apps have gotten bogged down with bad tech decisions and 'slop'. We have not... We regularly audit for performance regressions, often caused by sending too much data over websockets, css animations causing gpu spikes, lists being hard to render, and more."</user_quoted_section>

And the user-empathy version:

<user_quoted_section>"Our users drive agents all day and notice a dropped frame, a lying spinner, and a stale label. No continuously repainting animations; they peg the GPU on high-refresh displays."</user_quoted_section>

## The read path — the March flaw, comprehensively fixed

**March:** the client re-fetched the full DB snapshot every 100ms, with an unwired delta path.

**Now:** four coordinated mechanisms in `apps/server/src/ws.ts` (`subscribeThread`, ~line 1304). The code comments read like a postmortem archive, so I'm quoting them.

### 1. Snapshot moves off the socket

<user_quoted_section>"When the client already loaded the snapshot over HTTP it passes that snapshot's sequence, and we resume the live subscription by replaying persisted events after it instead of re-sending the (potentially multi-KB) snapshot frame over the socket."</user_quoted_section>

The client fetches the snapshot over HTTP (`threadSnapshotHttp.ts`, `shellSnapshotHttp.ts` in client-runtime — cacheable, streamable, not competing with live frames) and hands its sequence to the socket.

### 2. The subscribe-before-read race, handled

<user_quoted_section>"Attach live delivery before reading either replay or snapshot state. Otherwise an event published while the snapshot is loading is lost."</user_quoted_section>

The live PubSub stream is forked into an **unbounded queue bound to the stream's scope** *first*; then catch-up replay is emitted, then the buffered/ongoing live events. Overlapping events are deduped by sequence on the client. This is the classic snapshot/stream race and it's solved in the correct order with the reason written down.

### 3. Replay gap cap — from a real outage

<user_quoted_section>"A stale cached cursor can sit hundreds of thousands of global events behind — replaying that decodes every intervening event (including every other thread's tool payloads) only to discard almost all of them, which has OOM-killed servers on large databases. A truncated replay would silently drop this thread's events, so past the gap cap we reset the client with a fresh thread snapshot instead."</user_quoted_section>

`THREAD_RESUME_MAX_GAP`. Note the reasoning: truncating would be *silently wrong*, so the fallback is the correct-but-expensive path, not the cheap-but-lossy one.

### 4. Windowed snapshots, opt-in

<user_quoted_section>"Windowing the fallback snapshot is opt-in per subscription: clients that don't send turnLimit (including all pre-pagination clients) get the full thread, since they have no way to load older pages."</user_quoted_section>

Backward compatibility handled by capability rather than version sniffing.

### Keyset pagination underneath

`ProjectionSnapshotQuery.ts` is 2,689 lines and is where the real work lives:

- Windowed reads order turns by a **stable keyset** `(anchor, turn key)` over `COALESCE(turn_id, '')`. Both are event-derived, so **cursors survive** rebuilds.
- Sentinels `"~"` / `""` for unbounded ends (`"~"` sorts after any ISO timestamp).
- A CTE applies the keyset bound and `LIMIT` **before** the window functions run.
- Turnless rows (user messages, turnless activities) are bounded to the **matching turn-anchor time range** so they land on the same page.
- Each page carries a thread-scoped **watermark**, read inside the same transaction as the rows so the page boundary is consistent.
- A malformed or foreign-thread cursor **falls back to the first page rather than failing** — a stale cursor after a revert degrades gracefully.
- An explicitly documented tradeoff: a fan-out group can split across pages, and the cursor continues the same group, *"at the cost of splitting the fan-out group across pages."* Named, not hidden.

Backed by migrations `019_ProjectionSnapshotLookupIndexes`, `029_ProjectionThreadDetailOrderingIndexes`, `030_ProjectionThreadShellArchiveIndexes`, `037_ProjectionTurnsKeysetIndex`.

**Verdict: fully fixed, and hardened by production failures since.**

## Wire discipline

- **Per-subscription server streams.** ~17 stream methods; a client subscribes only to what it renders.
- **Buffered assistant delivery.** A thread in `buffered` mode accumulates assistant text instead of emitting every delta. Not held to turn end: `MAX_BUFFERED_ASSISTANT_CHARS = 24,000` — the append that *would* exceed it invalidates the buffer and spills the whole accumulated text as one delta; it also flushes at approval and user-input boundaries (`flushBufferedAssistantMessagesForTurn`). A bounded-latency, bounded-frames compromise.
- **`timelineBypass`** keeps child-agent activity off the parent timeline entirely.
- **`MAX_VISIBLE_WORK_LOG_ENTRIES = 1`** — the work log collapses to one visible entry with overflow folded.
- **Client activity + host power state reporting** (`server.reportClientActivity`, `reportHostPowerState`, `subscribeBackgroundPolicy`) — the server adapts what it sends based on whether anyone is watching and whether the host is on battery.

## Rendering

### Chat list

The March custom hybrid virtualizer with a CI-asserted height estimator is **gone**. Current: **`@legendapp/list`** (`LegendList`), the same library on web and mobile, plus a shared anchoring helper `resolveChatListAnchoredEndSpace` in `packages/shared/src/chatList.ts` — so anchoring behaves identically on both surfaces instead of drifting.

`MessagesTimeline.tsx` is 2,377 lines with logic split into a separately-tested `MessagesTimeline.logic.ts` (713 lines). The logic file preserves **row-reference stability for virtualization**: *"unchanged plan keeps its row reference (virtualization stability)."* Referential stability is what keeps a virtualizer from remeasuring.

Component-level: `memo`, `useCallback`, `useMemo`, `createContext`/`use` throughout; `EMPTY_AGENT_PANEL_MODEL` and `NOOP_OPEN_AGENTS` hoisted to module scope so default props don't allocate per render.

### Agents panel

Fixed three-line rows so data changes never change height; stable spawn order; static status dots; **DOM-write elapsed timers** (bypassing React for per-second updates); plain token counters.

### Terminals — React excluded entirely

`docs/architecture/terminal-renderers.md`. Web and Android both drive the official **`libghostty-vt` C ABI** — WASM on web into a **Canvas 2D** surface, JNI snapshot on Android — for parsing, terminal state, grapheme boundaries, keyboard encoding, selection, and scrollback.

<user_quoted_section>"React does not participate in terminal frames."</user_quoted_section>

The web runtime is **singleton-scoped per browser tab** so split terminals share one compiled module and memory; each visible terminal owns and frees its own terminal, render state, row/cell iterators, and encoders. Restoring captured scrollback **temporarily detaches the PTY callback** so historical device queries can't emit replies into the live shell — a subtle correctness bug they found and fixed.

Both artifacts build from one pinned revision (`native/libghostty-vt/VERSION`), and a CI test reads the revision back out of the binary via `ghostty_build_info` and compares it to mobile's `VERSION`. **Drift cannot hide.** The same test enforces an artifact size budget and exercises repeated create/write/free cycles with multi-codepoint graphemes.

### Diffs

`@pierre/diffs` rendered through a **worker pool** (`DiffWorkerPoolProvider.tsx`) — diff computation is off the main thread.

### Telemetry

`native/resource-monitor`, a standalone **Rust** binary using `sysinfo`, replaced recurring `ps` / PowerShell / `ioreg` / `pmset` subprocess probes. It owns bounded in-memory history; the server merges and summarizes **only when diagnostics requests it**; telemetry is not persisted to disk or continuously copied into Node.

There is also an `os-jank.ts` module in the server, which suggests they detect and account for OS-level scheduling jank.

## Deterministic async — still the house style

**`DrainableWorker`** (`packages/shared/src/DrainableWorker.ts`, 70 lines) survives and is the backbone. A transactional queue paired with a transactional count of outstanding items: `enqueue` atomically offers **and** increments; processing decrements; `drain` retries until the count reaches zero. So `drain` means "queue empty **and** the in-flight item finished" — the thing a naive queue-length check gets wrong.

All three reactors (`ProviderRuntimeIngestion`, `ProviderCommandReactor`, `CheckpointReactor`) expose `drain`. There's also a `KeyedCoalescingWorker` for per-key coalescing.

**`RuntimeReceiptBus`** survives with a sharpened role: typed async-milestone receipts (`checkpoint.baseline.captured`, `checkpoint.diff.finalized`, `turn.processing.quiesced`), but **`RuntimeReceiptBusLive` publishes nothing** — only the test layer is PubSub-backed, and the docs say *"Do not build production behavior on receipts."* The determinism mechanism was kept for tests and explicitly denied production semantics, so it can never become load-bearing by accident. This is a *better* design than March's.

The rule in AGENTS.md:

<user_quoted_section>*"The server is event-sourced and its async flows emit typed receipts. Wait on receipts and worker drains, never on sleeps or polling. A test that needs a timeout to pass is wrong."*</user_quoted_section>

## Error handling

- Effect typed errors throughout; RPC members declare typed error unions (`OrchestrationGetSnapshotError`, `EnvironmentAuthorizationError`, …) rather than throwing.
- `RenderErrorBoundary.tsx` on the client; `orchestrationRecovery.ts` for recovering client orchestration state.
- Engine-level: on dispatch failure it rereads persisted events past the starting sequence and reconciles.
- `RepositoryErrorCorrelation.ts` in persistence for correlating DB errors.
- `SlowRpcRequestToastCoordinator.tsx` — surfaces slow RPCs to the user instead of leaving a silent hang.
- Degradation over disappearance: an unknown driver becomes a visible `"unavailable"` snapshot; a bad cursor falls back to page one; a failed shell subscription shows as "connected with a sync error," not a fake reconnect.

## Testing

| Metric | Value |
| --- | --- |
| In-repo test files | **822** |
| Test LOC | ~231k (of ~713k total TS/TSX) |
| Ratio | roughly **1 line of test per 2 lines of source** |

Distribution: web 252, server 232, mobile 108, desktop 59, client-runtime 47, shared 42, relay 27, contracts 19, effect-acp 5, ssh 4, codex-app-server 4, plus ~20 for build scripts and 4 for the lint plugin.

Notable practices:

- **Contracts are tested** — 19 test files for schema definitions, so wire-shape changes are caught at the boundary.
- **Logic/view split**: `ChatView.logic.ts`, `MessagesTimeline.logic.ts`, `Sidebar.logic.ts`, `CommandPalette.logic.ts`, `BranchToolbar.logic.ts`, `GitActionsControl.logic.ts`, `threadActionMenu.logic.ts` — each with its own `.test.ts`. Presentation logic is unit-tested without a renderer.
- **Migrations have tests**, including the backfill and cleanup ones.
- `@effect/vitest` with deterministic service layers.
- Required connection-runtime coverage is enumerated in the docs as a contract: offline startup, forever-retry with 16s cap, explicit retry interrupting backoff, auth wakeups, involuntary close, explicit removal clearing owned state, relay token reuse/refresh, progressive relay discovery, cache hydration, durable subscriptions switching sessions, idempotent queued-command metadata.
- Integration tests exist where they matter (`CodexCollabRuntime.integration.test.ts`), plus `acp-mock-agent.ts` for testing ACP without a real CLI.
- **Local-scope testing is mandated**: *"Do not run repo-wide checks... CI owns the full suite."*

## CI

`.github/workflows/` — 12 workflows. `ci.yml` runs four jobs on PRs and pushes to `main`:

1. **Check** — `vp check` (format + lint), `vpr typecheck`, plus a desktop pipeline build that **verifies the preload bundle exists and still exports its expected symbols** (a real Electron footgun, gated).
2. **Test** — `vp run test` across the workspace.
3. **Mobile Native Static Analysis** — on macOS, wrapping `scripts/mobile-native-static-check.ts`.
4. **Release Smoke** — exercises release-only workflow steps via `scripts/release-smoke.ts`, *"so release breakage surfaces on PRs rather than at tag time."* Excellent idea.

Others: `deploy-relay`, `mobile-eas-preview`, `mobile-eas-production`, `mobile-fingerprint-check`, `mobile-showcase-screenshots`, `web-preview`, `pr-size`, `pr-vouch`, `issue-labels`, `thread-transfer-report`. `release.yml` builds macOS arm64/x64, Linux x64, and Windows x64 from one `v*.*.*` tag, auto-enabling signing only when credentials are present and still releasing unsigned artifacts otherwise.

### Custom lint plugin

`oxlint-plugin-t3code` — four repo-specific rules, each with a test:

| Rule | Enforces |
| --- | --- |
| `no-global-process-runtime` | No ambient global Effect runtime |
| `no-manual-effect-runtime-in-tests` | Tests use the provided harness, not hand-rolled runtimes |
| `no-inline-schema-compile` | Schemas aren't compiled inline in hot paths (a real perf trap) |
| `namespace-node-imports` | Consistent Node import style |

Encoding architectural invariants as lint rules is exactly the right move for a codebase mostly edited by agents.

## Code health grade: **A**

Justification at ~16k files / 482k LOC of source:

**Strong**

- **`: any` appears 6 times in non-test source across 482k LOC.** That is an extraordinary number, and it's backed by an explicit norm (*"Inferred types over annotations. `any` is the enemy."*).
- **Comments explain *why*, and cite the incident.** Invariants reference the PR/issue that motivated them (#4220, #3650, #4662, #4779, #5051). Tradeoffs are named rather than hidden. This is the single most impressive property of the codebase.
- **Documentation is current and honest.** `docs/internals/` matched the code everywhere I checked, has a maintained glossary with file links, and keeps a "Future work — these remain unbuilt, listed to keep the model honest" section.
- **Clean boundaries.** Contracts have no heavy runtime logic; `shared` has no barrel; `client-runtime` has no root export; complexity is pushed to adapter boundaries; orchestration is pure; the UI is dumb.
- **Type-level enforcement** where possible (`BuiltInDriversEnv` union making a missing runtime service a compile error).
- **Reverse states are mandated** — no one-way doors.
- **Migrations are versioned, tested, and willing to do hard cutovers** rather than accumulating compatibility cruft.
- **Legacy is labelled with its own deletion criteria** (`subagentRuntime.ts`).

**Weaknesses**

- **Large files.** `ProjectionSnapshotQuery.ts` 2,689 lines, `MessagesTimeline.tsx` 2,377, `ws.ts` >1,400, `rpc.ts` 1,075, `subagentRuntime.ts` 940. Well-organized and heavily commented, but these are single-owner files and a real onboarding cost.
- **A mid-flight migration in the most interesting subsystem.** `orchestration-v2` isn't landed; the v1/v2 dual path exists in the subagent surface today.
- **Effect-heavy.** Idiomatic and consistent, but it is a steep prerequisite. The repo has to vendor `effect-smol` into `.repos/` and instruct agents to read `LLMS.md` before writing Effect — that's a real signal about the learning curve. It's also on a **beta** line (`4.0.0-beta.103`).
- **Bleeding-edge toolchain.** Vite+ (`vp`), `@effect/tsgo`, `@typescript/native-preview`, pnpm 11, Node 24, and **16 patch files** in `patches/`. Fast and pleasant for them; a supply-chain and stability risk for a fork.
- **Cloud coupling.** T3 Connect is Clerk + Cloudflare + PlanetScale + Alchemy + APNs. Disabled in a fresh clone, and the local/LAN/Tailscale/SSH paths work without it — but the flagship remote experience does not.
- **Contribution is closed.** *"We are (mostly) not accepting contributions yet. Big features will not be."* Upstreaming fixes is not a viable strategy.

## Fork viability: **No — port the patterns.** (March verdict re-confirmed, and strengthened)

Legally trivial: **MIT**, and the project explicitly blesses forking (*"If we ever go the wrong direction, we want you to have everything you need to fork"*). A large number of users already run forks.

Practically wrong for us:

1. **You inherit operations, not a head start.** A meaningful fork means running your own relay (Cloudflare Workers + PlanetScale + Alchemy), your own Clerk tenant, your own APNs certificates, your own signed desktop release pipeline across three platforms, and your own App Store + Play Store listings.
2. **Merge pain is permanent.** ~1,479 commits in five months on a repo that rejects big external features. Every rebase is yours to own, forever.
3. **The product shapes diverge.** T3 is one-thread-one-agent with fleet *observability*. We are building fleet *orchestration*. That difference lives in the orchestration core — the part you'd have to rewrite anyway, and the part currently mid-migration to v2.
4. **The toolchain is a liability outside their team.** Beta Effect, Vite+, native-preview TS, 16 patches. Excellent when the authors are in the room; a maintenance tax when they aren't.
5. **The patterns are the value, and they're free.** Everything worth having — the read path, the adapter contract, `DrainableWorker`, the auth model, the supervisor state machine, the subagent invariants — is a design you can read in an afternoon and implement in your own stack. That's the actual transferable asset, and taking it costs you no operational surface at all.

**Recommendation:** treat T3 Code as a reference implementation and a source of hard-won invariants. Read `docs/internals/` in full, read `supervisor.ts`, `ws.ts` (`subscribeThread`), `DrainableWorker.ts`, `ProviderAdapter.ts`, and `subagentRuntime.ts` directly. Copy the reasoning. Write our own code.
