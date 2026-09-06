---
title: "Traycer performance root-cause analysis"
kind: spec
---

# Deep dive: performance problems

<user_quoted_section>Re-verified against ad605aa9 (2026-08-14). The original analysis ran against e372e303 (2026-07-23), 297 commits behind. This file has been amended: two root causes were fixed, one was fixed for remote hosts only, one is mid-migration, and one still stands verbatim. Verdicts are marked per section. Traycer's own production RCA independently confirmed three of my five findings — see "The vindication" below.</user_quoted_section>

## 0. The vindication — they found the same things, with a heap profiler

Commit **`0d15a80f` — `perf(gui-app): stop the renderer accreting multi-GB of Yjs structs and transcript copies (#966)`** (2026-08-05) is the single most important artifact in the delta. Its RCA:

<user*quoted_section>*"A production renderer was sitting at 4.86 GB after ~21 hours, and not coming back down. A CDP heap snapshot of a live session (543 MB → 1.36 GB over 28 minutes of agent streaming) attributed it… React fibers were flat, so the UI itself was innocent."\_</user_quoted_section>

Their three measured causes map directly onto my root causes #1, #3, and #4:

| Their finding                                                                                                             | Measured                                                                                                    | My root cause                                             |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Yjs struct growth — 1.55M → 4.79M `Item` structs in 35 min, traced to **39 live `Y.Doc`s in identical-count pairs**       | _"Yjs retains one `Item` per edit for the life of a doc — GC collapses deleted content, never the structs"_ | #3 (monolithic/accreting docs) + #1 (unbounded retention) |
| String duplication — 267 MB → 755 MB, _"the same transcript text retained several times over across derived projections"_ | —                                                                                                           | #4 / #1                                                   |
| Bursty 45–78% CPU — _"per-delta work that scaled with the **whole transcript** rather than with the delta"_               | —                                                                                                           | #4 (per-flush full re-parse)                              |

"React fibers were flat, so the UI itself was innocent" is the same conclusion I reached from the code: **the problems were architectural, not sloppy React.** That framing survives the delta intact and remains the most important thing this research produces.

## Root cause #1 — Resource caps waived while agents work

### ✅ **STILL STANDS — verbatim, unchanged**

Both waiver clauses are byte-identical to what I reported. Re-read at `ad605aa9`:

`stores/epics/open-epic/session-registry.ts`:

<user_quoted_section>"…or has active agent work, the registry temporarily stays above the cap until at least one entry becomes clean and inactive." — DEFAULT_MAX_LIVE_EPICS = 5</user_quoted_section>

`stores/chats/session-registry.ts`:

<user_quoted_section>"…sessions with active chat work are never evicted by the cap" — DEFAULT_CHAT_IDLE_TTL_MS = 10 min, MAX_ACTIVE_CHAT_IDLE_DEFER_MS = 1 hour, DEFAULT_MAX_WARM_CHAT_SESSIONS = 6</user_quoted_section>

**This remains the finding that best explains "bad while agents work", and it survived a dedicated multi-GB memory investigation untouched.** #966 bounded _artifact-room materialization_ (below) but did not touch _session retention_. The two are orthogonal: rooms are now cold-by-default, but the sessions holding transcripts, stores, and sockets are still exempt from eviction whenever an agent is running.

**Anti-constitution rule stands unchanged:** enforce caps _hardest_ under load. Separate cheap subscription liveness from expensive materialized retention.

### New and worth stealing: the lease/cold-room model

#966 introduced exactly the pattern I recommended, applied to artifact rooms:

<user_quoted_section>"rooms now arrive cold, as encoded update bytes, and materialize a Y.Doc only while something leases it. CollabTileBody holds a lease while mounted; export holds one for the read. Cooling is refused for any replica carrying edits the host hasn't acknowledged — encoding it down would discard the queued update… 60s linger so tile remounts don't re-materialize; LRU cap of 8."</user_quoted_section>

Also: the per-room `hostCoverageDoc` was deleted as _"**write-only** — half of every pair was a full replica maintained for nothing"_ (that's the "identical-count pairs" in the heap), and offline update queues now collapse via `Y.mergeUpdates` past a threshold so _"a long disconnect costs O(document) instead of O(edits)"_.

**Steal all of this.** Cold-by-default + lease-to-materialize + dirty-guard-refuses-cooling + LRU + linger is the correct shape for CRDT room lifecycle. Note the dirty guard especially — cooling a room with unacknowledged edits would silently discard offline work.

## Root cause #2 — Per-RPC WebSocket dial + manifest handshake

### ⚠️ **STILL STANDS for local hosts. FIXED for remote hosts.**

`buildManifest()` is **still called per request and still unmemoized** at `ws-rpc-client.ts:290` / `:429`:

```ts
private buildManifest(): SplitConnectionManifest {
  return splitConnectionManifest(this.registry, RELEASED_FLOOR_METHOD_NAMES);
}
```

And the new `negotiated-manifest-registry.ts` states the behavior outright as current fact:

<user_quoted_section>"Unary RPCs re-handshake on every call (WsRpcClient.requestWithResponseTimeout dials, sends open, awaits openAck)… WsRpcClient (local): records on every unary ack — per-call re-handshake is the refresh cadence."</user_quoted_section>

Th**is got worse in absolute terms:** the method catalog grew from ~130 to **279**. Every local unary RPC now builds, serializes, parses, and compatibility-checks a 279-entry manifest**.**

**But they built the right architecture — for remote hosts only.** The `remote-host` epic (#188, #1133, #1093, #1160) added a full multiplexed transport under `clients/shared/host-transport/remote/`: `remote-session.ts`, `logical-stream.ts`, `noise-channel.ts` (Noise-protocol encryption), `relay-socket.ts`, `scheduler.ts`. Same registry doc:

<user_quoted_section>"RemoteSession (remote mux): records at each session-open ack — the re-attach after a socket drop is the refresh cadence, since the session is long-lived."</user_quoted_section>

So Traycer now runs **two transports with opposite performance characteristics**: a long-lived multiplexed session for remote hosts, and per-call dialing for the local host most users actually run. The local path was never migrated.

**Anti-constitution rule stands, and is now evidence-backed by their own remote implementation:** one persistent multiplexed connection per host, handshake once, memoize the manifest. They proved the design works; they just didn't backport it.

## Root cause #3 — Monolithic Epic Y.Doc holding chat messages

### ⚠️ **STILL STANDS in the epic doc — but a replacement architecture is landing**

The epic record at `ad605aa9` still carries chats:

```ts
export const epicSchema = z.object({
  id,
  title,
  isTitleEditedByUser,
  createdAt,
  updatedAt,
  chats: z.record(z.string(), chatSchema), // ← still here
  artifacts,
  deletedArtifacts,
  tuiAgents,
  roleClaims: roleClaimsSchema.default({}), // ← new
});
```

and the projector's doc-comment is unchanged: _"messages/blocks live in flat YKeyValue collections; the GUI never reads them from the doc (chat.subscribe streams Message[])."_

**However — Chat-sync v2 (#951, #1134, #1164) is a genuinely new persistence architecture that solves exactly this,** and it is the most significant design development in the delta. From `protocol/src/persistence/_internal/chat-sync-schemas.ts`:

<user*quoted_section>*"A published chat is a small mutable head plus a set of immutable, content-addressed shards. Unlike epic, neither lives in a Yjs doc: the head is the opaque JSON on a chat's cloud row, and the shards are objects in storage the head names by content hash… shards hold the transcript, so an append rewrites one cohort rather than the whole chat."\_</user_quoted_section>

Design details worth stealing:

- **Head/shard partition by evolution speed** — the head's `core` is what cloud renderers and clone targets interpret and _"evolves at reader speed"_; `hostPrivate` is opaque to the protocol and _"evolves at host speed"_.
- **Residual bags** — _"Every modeled object captures its unmodeled keys into a `residual` bag, so a field a newer minor adds survives an older reader's re-publication instead of being stripped."_ This is forward-compatibility done properly.
- **Self-identifying payloads** — `schemaVersion` is carried inside both records _"so an object found detached from the head that named it is still self-identifying"_, pinned to a literal so _"a v1.0 parser can never accept a payload claiming to be something else."_

`#1164` ("CDC cut plan and cohort membership") indicates a cutover in progress. **Status: the old problem persists in the epic doc; the replacement exists alongside it and is the right design.**

**Anti-constitution rule stands, now with a reference implementation:** content-addressed immutable shards + a small mutable head is a better answer than "per-chat CRDT room", because an append rewrites one cohort instead of touching a CRDT at all. I'd revise my original recommendation toward this shape.

## Root cause #4 — Per-flush full markdown re-parse

### ✅ **FIXED**

Their RCA named it precisely — _"per-delta work that scaled with the whole transcript rather than with the delta"_ — and #966 plus #1016 fixed it:

- **`feat(gui-app): adopt Tailmark for streaming chat markdown (#1016)`** — `@tailmark/core` + `@tailmark/react` are now dependencies alongside `react-markdown`. A streaming-oriented markdown engine replaced the full re-parse on the chat path.
- **`ec349e61`** — _"rendered turns are signed **per record** and memoized on object identity, instead of re-hashing every block on every pass."_ The rationale is sharp: identity is the correct key _"precisely because settled turns are not immutable — detached subagent writes and snapshots both mutate them — but both mint new objects."_
- **`ca13c3e8`** — the Shiki cache is now budgeted by _estimated retained bytes_ rather than HTML characters, and keyed by a **hash of the source instead of the source**, which had meant _"every cached block also retained a second copy of its own text that the budget never counted."_
- **`ffd718cc`** — the turn minimap ran `replace(/\s+/g," ")` over the _entire_ turn to build a 200-char preview, allocating a full second copy of every turn. Now slices first.
- **`973bde39`** — the accumulated-changes panel ran `structuredPatch` over every touched file's full before/after **on every snapshot frame**; now memoized on a content _fingerprint_, _"which is deliberately not the content: keying by it would retain a second copy of every edited file."_

**Verdict: fixed, and the fixes are instructive.** Two of them (hash-as-key, fingerprint-not-content) are about _cache keys that accidentally retain a second copy of what they key on_ — a failure mode worth encoding as a rule in our own work.

## Root cause #5 — `display:none` keep-alive + Virtuoso scroll fight

### ❌ **OBSOLETE — the entire mechanism was replaced**

**`feat(gui): replace chat transcript scroller with LegendList (#828)`.** `chat-messages.tsx` now imports `LegendListRef` from `@legendapp/list/react`. My analysis of Virtuoso's `atBottom` latching, the `"defend"` rAF loop, and `cancelSmoothScroll` describes code that **no longer exists**.

Follow-up work in the delta shows this was an active, sustained campaign, not a one-shot swap:

`refactor(gui-app): simplify chat scroll behavior (#946)` · `fix: preserve chat scroll intent across remounts (#907)` · `fix: preserve chat follow through layout changes (#1042)` · `fix: prevent chat follow correction races (#1140)` · `fix: **prevent hidden chat geometry poisoning** (#1159)` · `feat: harden chat scroller lifecycle and surface hosting (#903)` · `feat: persist reading positions globally (#972)` · `feat: show live activity in a **bounded, tail-following window instead of a jumping standalone block** (#899)` · `fix: keep active minimap row visible (#1041)` · `fix: preserve delayed scrollbar departures (#1174, HEAD)`

The current code treats LegendList's `isAtEnd` as authoritative — _"never an independent source of truth"_ — which is the opposite of the old architecture's competing-owners problem, and matches what I recommended.

**Verdict:** the specific finding is dead. **The underlying lesson survives and is arguably strengthened**: ~15 commits across six weeks, a full scroller replacement, and a commit literally named _"hidden chat geometry poisoning"_ all confirm that hidden-surface measurement corruption is a real and expensive class of bug. My rule — _never `display:none` a virtualized transcript; one owner of scroll position_ — is unchanged, and Traycer arrived at the same place the hard way.

## Scorecard

| #   | Root cause                             | Verdict at `ad605aa9`                                                                      |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | Caps waived while agents work          | ✅ **Stands, verbatim** — survived a multi-GB investigation                                |
| 2   | Per-RPC dial + manifest handshake      | ⚠️ **Stands for local hosts**; fixed for remote via mux. Manifest now 279 methods          |
| 3   | Chat messages in the epic Y.Doc        | ⚠️ **Stands**; Chat-sync v2 (head + content-addressed shards) is the in-flight replacement |
| 4   | Per-flush full markdown re-parse       | ✅ **Fixed** (Tailmark + identity memoization + cache-key fixes)                           |
| 5   | `display:none` + Virtuoso scroll fight | ❌ **Obsolete** — Virtuoso → LegendList; lesson survives                                   |

**Two of five fixed, one fixed only on the path most users don't use, one mid-migration, one untouched.** For our anti-constitution: rules derived from #1, #2, and #3 remain fully load-bearing. The rule from #4 should be re-framed as _"cache keys must not retain a second copy of what they key"_. The rule from #5 should be kept as a principle, not as a Virtuoso critique.

## Secondary contributors — re-checked

| Issue                                 | Status                                                                                                                                                                                                                                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Perf telemetry opt-in only**        | ✅ **Fixed.** `969a48e3` added _"periodic renderer memory/CPU samples into PostHog… plus a pressure event above thresholds, so the next report of this comes with data instead of a screenshot"_, plus a heap-snapshot action under Diagnostics.                                 |
| **Only 2 of 406 commits `perf(...)`** | Improved: 3 more landed (#966, #815, plus #462/#67 prior). Still not a standing workstream, but #966 is a serious, well-instrumented investigation.                                                                                                                              |
| **Poll storms**                       | More mitigations: _"stop the 15s host-directory poll from churning every consumer"_ (#971), _"keep host-recovery sweeps from re-probing harness catalogs"_ (#977), _"un-strand host-scoped queries after a host stall"_ (#794). Pattern of ongoing polling pathologies persists. |
| **Giant components**                  | Unchanged in kind.                                                                                                                                                                                                                                                               |
| **Zod on the hot path**               | Unchanged; now across 279 methods.                                                                                                                                                                                                                                               |
| **Oversized envelopes**               | New: _"whole-body mux chunking for oversized envelopes"_ (#1160) — large payloads were breaking the mux transport.                                                                                                                                                               |

## What to keep — updated

Still worth copying: the global flush coordinator with visibility tiers; the single-`setState`-per-Y-transaction projector; lazy-loaded xterm/Shiki; the atlas scheduler. **Add from the delta:** the cold-room lease model with a dirty-guard; content-addressed transcript shards; identity-based memoization of mutable-but-object-minting records; byte-budgeted caches keyed by hash; and always-on sampled memory/CPU telemetry with a pressure event.
