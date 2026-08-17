---
title: "T3 Code research (current main)"
kind: spec
---

# T3 Code — research report (current `main`)

**Snapshot:** commit `c9063f03e` (2026-08-15), branch `main`.
**Scope:** 15,970 tracked files · ~482k LOC of source TS/TSX · ~231k LOC of tests · 822 in-repo test files · MIT licensed (T3 Tools Inc.).

<user_quoted_section>This report supersedes the March 2026 snapshot report, which was taken 1,479 commits behind and is wrong on every headline claim. Nothing from it was carried forward except the list of questions.</user_quoted_section>

## What T3 Code is, in one paragraph

T3 Code calls itself an **"agent harness control surface."** It is not an editor and not an agent. It is a Node WebSocket server that wraps the coding-agent CLIs already installed and authenticated on your machine (Codex, Claude Code, Cursor, Grok, OpenCode) and serves three clients — web, Electron desktop, and a React Native iOS/Android app — over one authenticated Effect RPC WebSocket. The server is the execution boundary: every provider process, terminal, git operation, and filesystem read happens there, never in the client. It has 100,000+ users and is developed largely from inside itself, often driven remotely from a phone.

## Executive summary

1. **Codex-only is dead.** Five provider drivers ship built in — `codex`, `claudeAgent`, `cursor`, `grok`, `opencode` — behind a clean driver+adapter contract. Adding one is "write the driver and adapter, add to `BUILT_IN_DRIVERS`"; no orchestration, contract, or client change.
2. **Multi-agent exists and is excellent** — but as *observability*, not orchestration. T3 renders a fleet roster of the subagents/workflows the **provider** spawns, with phases, per-agent token metrics, and a workflow-script viewer. It never spawns a fleet itself.
3. **Remote is a real subsystem**, five access methods deep: direct bearer pairing, T3 Connect relay (Cloudflare tunnel + Clerk, with its own deployed Worker + PlanetScale infra), Tailscale (`tailscale serve` managed by the server), desktop-managed SSH (discovers, launches, forwards, pairs), and platform-primary.
4. **Auth is a genuine capability system**: 8 OAuth-style scopes, RFC 8693 token exchange, DPoP proof-of-possession, and 5-minute single-purpose WebSocket tickets so no long-lived credential ever appears in a socket URL. Per-RPC-method scope enforcement.
5. **The event-sourced CQRS core survived and hardened.** Command → durable receipt (idempotent retry) → pure decider → events + projections **in one SQL transaction** → read-model swap → publish. 40 numbered migrations.
6. **The March O(everything) read path is comprehensively fixed.** Snapshot arrives out-of-band over HTTP; the socket carries `afterSequence` event replay with a live buffer attached *before* the snapshot read (race-free), a `THREAD_RESUME_MAX_GAP` cap (because unbounded replay OOM-killed real servers), client-side sequence dedup, and keyset-paginated windowed thread reads with cursors and watermarks.
7. **Rendering:** the custom hybrid virtualizer is gone. Web and mobile share `@legendapp/list` plus a shared anchoring helper, so the chat list behaves identically on both.
8. **Terminals bypass React entirely.** Web and Android both drive the official `libghostty-vt` C ABI — WASM on web into a Canvas 2D surface, JNI on Android — from one pinned upstream revision, with a CI test that reads the revision back out of the binary so the two pins cannot drift.
9. **Resource telemetry** replaced recurring `ps`/PowerShell/`ioreg` subprocess probes with a standalone Rust `sysinfo` monitor holding bounded in-memory history.
10. **Feature surface is far larger than "chat with an agent":** full GitHub PR review client, in-app browser preview with automation and annotation, terminals, checkpoint/diff/revert per turn, worktrees and stacked-git actions, a usage/cost dashboard, command palette, theming with VSCode/OpenVSX theme import, and a thread inbox (pin/snooze/settle/archive).
11. **Quality discipline is exceptional and measurable:** 6 occurrences of `: any` in non-test source across 482k LOC; a custom oxlint plugin enforcing four repo-specific invariants; comments that cite the shipped bug number that motivated the invariant.
12. **Deterministic async is a house rule, not a suggestion.** `DrainableWorker` and the typed receipt bus both still exist. Receipts are now explicitly test-only (production publish is a no-op). AGENTS.md: *"A test that needs a timeout to pass is wrong."*
13. **`orchestration-v2` is in flight.** The client-side subagent fold is self-labelled legacy-bridge code scheduled for deletion, with field names copied from v2 so the swap is mechanical. Anything we copy from that file should be copied from its *shape*, not its lifetime.
14. **Fork viability: still no — and now emphatically no.** The March verdict was right for the wrong reason. At 16k files with a live relay, a Clerk tenant, App Store and Play Store presence, and signed desktop release infrastructure, a fork inherits an operations burden, not a head start. Port the patterns.
15. **Strategic read for our project:** T3 and Traycer compose rather than overlap. T3 is the harness-control, remote-access, and performance substrate; Traycer is the multi-agent orchestration pillar. T3's *own* multi-agent surface is the observability half of what we want to build, and it is the single best reference implementation of that half we have found.

## Deep dives

| Artifact | Covers |
| --- | --- |
| [Feature inventory](./feature-inventory/) | Every user-facing feature, how each works |
| [Architecture map](./architecture/) | Process model, stack, monorepo, persistence, wire protocol, orchestration loop |
| [Multi-agent & providers](./multi-agent-and-providers/) | The Agents fleet panel, subagent fold, the five drivers, ACP |
| [Remote & multi-machine](./remote/) | Five access methods, relay, auth model, SSH, failure handling |
| [Performance & quality](./performance-and-quality/) | Rendering, read path, deterministic async, testing, CI, code health grade |

## What changed since March — the four stale claims

| March claim | Status | Reality on current `main` |
| --- | --- | --- |
| **Codex-only by contract** | ❌ Dead | Five drivers: Codex, Claude, Cursor, Grok, OpenCode. Cursor and Grok speak **ACP** (Agent Client Protocol) through a purpose-built `packages/effect-acp`; Codex has `packages/effect-codex-app-server`; OpenCode has its own runtime. The orchestration layer does not know which agent is behind a thread. |
| **No multi-agent capabilities** | ❌ Dead | A dedicated Agents fleet panel (`AgentsPanel.tsx`) over a 940-line source-neutral subagent fold, modelling subagents, workflows, workflow-agents, phases, attempts, parent/child hierarchy, per-agent usage, and run handles. Observability of provider-spawned fleets, not orchestration of T3-spawned ones. |
| **Thin remote (LAN bind + unsent static token)** | ❌ Dead | Five access methods, a deployed Cloudflare Worker relay with PlanetScale persistence, APNs push + **iOS Live Activities** for agent progress, DPoP-bound tokens, scoped capabilities, and short-lived WebSocket tickets. The unsent-token flaw is architecturally impossible now. |
| **Client re-fetches full DB snapshot every 100ms; delta path unwired** | ❌ Dead | Poll replaced by per-subscription server streams. Snapshot moved off the socket to HTTP; the socket replays events after a client-supplied sequence. Race, OOM, and stale-cursor cases are each explicitly handled and commented. |

## Surprises worth naming

- **AGENTS.md is a performance constitution.** It names the actual regression sources ("sending too much data over websockets, css animations causing gpu spikes, lists being hard to render") and bans continuously repainting animations because they peg the GPU on high-refresh displays. It also contains a section titled "The three ways to hurt yourself" written for agents editing the repo *while the maintainer is using the app*.
- **The repo is its own primary contributor.** "Most T3 Code contributions will come from T3 Code itself, often controlled remotely." The docs, the seeded-test-data workflow, and the kill-safety rules all exist because agents work in this repo against a live install.
- **Vendored reference repos.** `.repos/` holds read-only upstreams (`effect-smol`, `alchemy-effect`) that agents are told to read for patterns and forbidden to import from — a deliberate "prefer their patterns over invented ones" mechanism.
- **`@pierre/diffs`** for diff rendering plus a `DiffWorkerPoolProvider` — diffs are computed off the main thread.

## Top 5 "steal this"

1. **Snapshot-over-HTTP + sequence-resumed event stream over WS**, with the live subscription attached *before* the snapshot read and a hard replay-gap cap that falls back to a fresh snapshot. This is the single highest-leverage pattern in the repo and it is annotated with the production failure that shaped each branch.
2. **The provider driver/adapter boundary.** A ~15-method adapter interface (`startSession`, `sendTurn`, `interruptTurn`, `respondToRequest`, `streamEvents`, …) with per-driver config schemas and a two-registry split (configured instances vs live adapters). It makes "which agent" a routing detail.
3. **`DrainableWorker` + drain-based test synchronization.** A transactional queue paired with a transactional outstanding-count; `drain` returns when the count hits zero. Tests await real quiescence instead of sleeping. Pair it with the AGENTS.md rule that a test needing a timeout is a broken test.
4. **The subagent fold's invariants**, especially *order-robust folding*: a completion event can create an agent, and a late start event only fills in metadata. Plus `TaskAgentLinkage` repeated on every lifecycle row so an agent survives its start row aging out of retention. These are exactly the bugs a fleet UI hits, already solved.
5. **Scoped capability auth with short-lived WebSocket tickets.** Long-lived credential in headers → ticket → socket URL, with per-method scope checks so holding a socket is not authorization to call everything on it.

<TRAYCER_NEXT_STEPS>
The T3 Code research is complete across five artifacts. Natural next moves:

- [] Read the multi-agent-and-providers deep dive and tell me which parts of T3's Agents panel model we should adopt wholesale for our fleet view.
- [] Compare this report against the Traycer research and produce a combined architecture proposal for our app.
- [] Do a focused follow-up on T3's orchestration-v2 migration — what the v2 subagent projection looks like and whether we should target it directly instead of the v1 fold.
  </TRAYCER_NEXT_STEPS>
