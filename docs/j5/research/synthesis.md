---
title: "Research synthesis: what we build, what we steal, what we design fresh"
kind: spec
---

# Research synthesis (v2 — verified against current code)

<user_quoted_section>Supersedes the earlier on-hold draft. T3 Code read at c9063f03e (2026-08-15, ~482k source LOC); Traycer verified at ad605aa9 (2026-08-14). Full reports: t3code/ (6 artifacts) and traycer/ (4 artifacts, delta-verified). The March-snapshot T3 report is quarantined at ../t3code-stale-march-snapshot/.</user_quoted_section>

## The thesis

**T3 Code observes and controls agents; Traycer orchestrates them. Neither does both. Our app is the composition — plus the one capability neither has: a fleet that truly spans machines.**

- T3 Code (100k+ users): one-thread-one-agent _control surface_ over five harnesses (Codex, Claude, Cursor, Grok, OpenCode), with a first-class **fleet observability panel** for whatever the provider spawns — but it never spawns or coordinates agents itself, and has **no cross-environment state sync**. _(Correction 2026-08-19: the parenthetical this sentence originally carried — "a client connects to one environment at a time" — is stale. Current code connects the client to ALL saved environments concurrently and aggregates threads/attention across them; only server-side state remains per-environment. Verified in `remote-hosting.md`.)_
- Traycer: **fleet orchestration** — peer A2A messaging, epics, hierarchy, artifacts, roles — but agent identity only _replicates_ across hosts; message delivery still rejects non-local receivers (`RECEIVER_NOT_LOCAL`), even after they shipped an encrypted remote transport and didn't route A2A over it.

## Foundation decision

**REVISED (2026-08-14, after Jackson's challenge): tracking fork of T3 Code.** Full analysis: `t3code/fork-viability.md`. The original "greenfield" verdict conflated forking the product-plus-cloud with forking the codebase as a foundation; the deeper entanglement claim did not survive reading the orchestration core.

- T3: **fork and track** **— from the orchestration-v2 branch (`t3code/codex-turn-mapping`), not main.** Timing analysis in fork-viability §7 (see also `t3code/orchestration-v2.md`). Main is ruled out: v2 lands as a hard cut that rewrites everything our orchestration work would touch (decider/projector/read-model, `mcp/`, thread model), while the fork's _raison d'être_ — relay, SSH, Tailscale, terminals, auth, the platform event-sourcing data plane — is measurably untouched by the cut (0-file overlap in those packages). Decisive asymmetry: upstream's only release blocker is v1-user state migration, and we are fresh-state — we can build on v2 before they can ship it.
- **What v2 gives us free** (shrinks our build ~2–3 mo → ~6–10 weeks of higher scope): server-side `SubagentProjection`, `delegate_task` + thread start/send/wait/interrupt with steer/queue modes, MCP injection into all five providers natively, scoped per-session creds, relationship graph, `ContextTransfer` (fork/merge-back/provider-switch/device handoff), ACP registry driver. **Still ours**: peer-to-peer A2A with typed silence (v2 is hierarchical parent→child only), epic container + artifacts, first-class roles, cross-machine routing.
- **Sequencing**: Phase 1 now, base-independent — infra swap, bundle-ID rename, read the 9 v2 design docs, design epic/artifacts/roles against v2 contracts. Phase 2 when #2829 merges — orchestration-adjacent build on settled v2. Add-don't-modify discipline doubles as the squash-merge mitigation (new files cherry-pick cleanly onto a new base).
- **Retired risk**: the v1 single-fiber command queue is fixed in v2 (`KeyedSerialExecutor` — per-thread serialization, no process-wide mutex; durable SQL-backed `EffectOutbox`). Load test demoted from decision gate to validation. **Remaining risks**: Effect 4 beta commitment (tracking inherits T3's fixes), 7,253-line `Orchestrator.ts` maintainability, draft-branch squash-merge churn, divergence debt if rebase discipline slips.
- Traycer: unchanged — Host closed-source, not forkable. **Vendor** `protocol/src/framework/` (~14 MIT files — version negotiation, frozen shapes, fail-closed downgrades, residual bags, self-identifying payloads).

## Engineering constitution (proven at scale in T3's current code)

1. **Event-sourced CQRS core**: command → durable idempotency receipt → pure decider → events + projections in one SQL transaction → read-model swap → ordered publish.
2. **Snapshot + resumable delta streams**: snapshot over HTTP; WS event replay from client `afterSequence`; live subscription attached _before_ the snapshot read; hard replay-gap cap falling back to fresh snapshot (unbounded replay "has OOM-killed servers"); per-subscription streams, never broadcast-everything.
3. **Deterministic async as house rule**: `DrainableWorker` (drain = queue empty AND in-flight done) + typed milestone receipts; tests await milestones, never sleep. "Has the fleet settled?" is our central question — this is the highest-leverage pattern.
4. **Provider driver/adapter boundary**: ~15-method adapter, per-driver config schemas, registries for configured-vs-live; adding a harness touches no orchestration/contract/client code. ACP (`effect-acp`) as the cheap lever for harness breadth.
5. **Order-robust event folding** (bug-numbered invariants): a completion event can _create_ an agent, late start only fills metadata; linkage repeated on every lifecycle row so identity survives retention; deny-list (not allow-list) classification because SDK names drift; idle is a real non-terminal state; terminal timestamps first-write-wins.
6. **Capability auth from day one**: scoped tokens, RFC 8693 exchange, DPoP, 5-minute single-purpose WS tickets, per-RPC-method scope checks. Relay as **control plane only** — broker credentials + endpoint, then direct tunnel traffic.
7. **Buffered-by-default delivery, streaming opt-in**, with spill thresholds and flush-at-boundary rules.
8. **Virtualize settled history only; live turn stays real DOM**; one authority for scroll position (`isAtEnd` authoritative — both apps converged on this independently).
9. **Heavy surfaces bypass React**: terminals via libghostty-vt (WASM→Canvas), native probes via a Rust `sysinfo` binary, pinned revisions asserted by CI.
10. **Quality as measurable gates**: ~48% test-to-source LOC, 6 `: any` in 482k LOC, custom lint rules encoding architecture, comments citing the shipped bug behind each invariant, an explicit performance constitution in AGENTS.md.
11. **Read before writing our connection layer**: T3's `client-runtime/src/connection/supervisor.ts` — a year of mobile-reality reconnect wisdom (probe-don't-reconnect, honor post-suspension reconnects, don't burn retries offline, block on auth failure).

## Anti-constitution (Traycer's flaws, delta-verified — 3 of 5 confirmed by their own 4.86 GB heap investigation, #966)

1. **Never waive resource bounds under load** — their caps are still suspended whenever agents work; survived their own memory RCA untouched. Degrade fidelity, never unbound.
2. **Persistent connections, cheap calls** — per-RPC WS dial + 279-method manifest handshake still ships for local hosts (they fixed remote only).
3. **Shard hot state by access pattern** — chat still lives in the epic CRDT doc (their in-flight fix, Chat-sync v2's content-addressed head+shards with no CRDT in the append path, is _better_ than per-chat CRDT rooms — study it).
4. **Bound streaming work per delta, not per frame**; cache keys must not retain a second copy of what they key on.
5. **Track performance as a workstream** — they could see the problem (shipped block probe) and didn't work it until it hit 4.86 GB.

## Product model to adopt (Traycer, all delta-verified)

- **Epic as container** (agents + terminals + artifacts + N folders + worktrees); hierarchy via `parentId`; broker owns delivery (ephemeral), store owns identity (durable).
- **A2A**: typed silence with 7 trust-annotated reasons (`awaiting-input` breaks the waits-on-human deadlock); thread-scoped idempotent `responseId`; protocol semantics injected as prompt text; discriminated-union selections; data-minimization projections; warnings-not-rejection on create.
- **New must-steals**: **Communication Graph** (exactly-once, gap-free per-epic A2A event log with playback — the "who asked whom what, where did it stall" primitive) and **agent role claims** (runtime half of our agent-types idea).
- Clone-not-migrate host binding; lifecycle from harness hooks; per-row capability discovery.
- **Product caution**: Traycer tried and removed "Epic Mode" (#749) — avoid two-mode UX splits.

## Our headline design work (neither app has it)

1. **Cross-machine fleets**: T3 proved the remote transport + auth layer; Traycer proved single-host orchestration; nobody routes A2A across hosts or syncs fleet state across environments. This is the flagship differentiator — design it into the event/message layer from day one.
2. **PR dashboard** (`../backlog.md`) — fleet-level PR state fed by sitter agents; study Jackson's personal site when available.
3. **Agent types/roles** (`../backlog.md`) — definition half (SOUL.md-style) + Traycer's role-claims runtime half.

## Open questions for the design phase

- **Stack**: T3 proves web-tech desktop hits the bar (Effect-TS + React + Electron/RN). Do we adopt Effect-TS wholesale or port its architectural discipline to plainer TS? Needs a real debate with team fluency weighed.
- **Sync substrate for cross-machine**: extend T3's event-sourced replication vs Traycer's CRDT docs vs hybrid (events for commands/chat, CRDT only for genuinely collaborative artifacts; Traycer's Chat-sync v2 suggests even chat shouldn't be CRDT).
- **Authority topology**: where does an epic "live" when its folders span machines — home-host authority with remote participants (Traycer's model, generalized) vs replicated authority?
- **Follow-up deep dives available on demand**: T3's orchestration-v2 target shape (if we build server-side subagent projection), Chat-sync v2 cutover mechanics, remote mux codec.
