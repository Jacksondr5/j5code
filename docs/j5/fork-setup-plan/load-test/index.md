---
title: "J5 Code fleet load test and provider smoke"
kind: spec
---

# J5 Code fleet load test and provider smoke

Recorded 2026-08-15 on macOS 26.6.1 arm64 and Node 24.14.0. The add-only T6 harness is merged on `j5/main` at `e7597dac8324d0f0c30a6c0b3956959092606c29`.

## Verdict

**Pass for the 30-thread interactive-dispatch target.** Across five fresh, isolated runs, the median 30-thread dispatch p95 was **1.017 ms** and the median whole-batch time was **22.809 ms**. Both are far inside the explicit harness thresholds of 250 ms p95 and 1,000 ms per batch. No cross-thread contention appeared.

This is an orchestrator/data-plane result, not a claim that 30 simultaneous model processes will finish in the same time. Provider startup, model latency, MCP/HTTP/WebSocket serialization, rendering, and long-soak leak behavior are deliberately excluded.

## Reproduce

```sh
scripts/j5/fleet-load.sh
```

Implementation: `apps/server/src/j5/fleet-load.ts`. The launcher resolves and changes to the repository root, reads `.nvmrc`, and uses fnm, so it works from another directory and does not alter the machine's default Node.

Optional `--keep-state` preserves that run's temporary state directory for inspection. Without it, the harness prints the exact state path and removes only the temporary directory it created.

Validation performed:

```sh
shellcheck scripts/j5/fleet-load.sh
fnm exec --using 24.14.0 pnpm exec vp lint apps/server/src/j5/fleet-load.ts
fnm exec --using 24.14.0 pnpm exec vp fmt --check apps/server/src/j5/fleet-load.ts
fnm exec --using 24.14.0 pnpm exec vp run --filter t3 typecheck
```

All passed. The server typecheck retained only pre-existing Effect suggestions outside the new harness.

## Method

- Composes the production `OrchestrationV2LayerLive` and event sink against a fresh file-backed SQLite database.
- Registers a stub Codex adapter that advertises real v2 capabilities but never starts a model process or network request.
- Creates one agent/MCP-origin baseline thread, then measures 30 sequential metadata dispatches on that one key.
- Creates 30 agent/MCP-origin threads concurrently, then dispatches one metadata command to every thread concurrently. This directly exercises the production `KeyedSerialExecutor` path without model latency.
- Samples process RSS every 2 ms and records the SQLite database/WAL/SHM footprint plus unified application-event counts before and after the measured commands.
- Runs in a fresh `j5-fleet-load-*` temporary state root each time. Jackson's installed T3 Code and J5 Code state are never read or written.
- A pass requires both latency thresholds and exact returned/durable event reconciliation.

The 250 ms p95 / 1,000 ms batch thresholds are an operational definition of “feels interactive” for local command acceptance, not an upstream service-level objective.

## Results

Five fresh runs were recorded. Values below are medians across runs; ranges show observed minima and maxima.

| Measurement               | One active thread                          | 30 active threads         |
| ------------------------- | ------------------------------------------ | ------------------------- |
| Dispatch p50              | 1.102 ms (0.960–1.297)                     | 0.700 ms (0.691–0.844)    |
| Dispatch p95              | 3.404 ms (3.068–3.831)                     | 1.017 ms (0.821–1.101)    |
| Whole batch               | sequential samples, not timed as one batch | 22.809 ms (21.914–25.534) |
| Concurrent creation p95   | —                                          | 1.352 ms (0.993–1.642)    |
| Concurrent creation batch | —                                          | 19.991 ms (19.781–24.503) |

The 30-key p95 was 25–32% of the single-key sequential p95 in these runs. That direction is expected from independent keyed dispatch plus SQLite/runtime warmup; it is not evidence that concurrency makes individual work intrinsically faster.

### Memory and event store

| Measurement                        | Result                                                 |
| ---------------------------------- | ------------------------------------------------------ |
| Median peak RSS growth             | 5,881,856 bytes (5.61 MiB)                             |
| Peak RSS growth range              | 5,799,936–8,241,152 bytes                              |
| Unified v2 events                  | 1 before → 91 after; exactly 90 measured events        |
| Stored-event result reconciliation | 90 returned / 90 durable                               |
| SQLite + WAL + SHM growth          | 4,205,552 bytes (4.01 MiB), identical in all five runs |

The stable 4.01 MiB delta is primarily SQLite/WAL allocation footprint for this short fresh-database run, not an estimate of per-event payload size. The exact event reconciliation shows no dropped or duplicated command events. RSS stayed at the allocator's post-run high-water mark; a five-run fresh-process test cannot prove or disprove a long-soak leak. No superlinear growth or contention signal appeared within this ticket's scope.

## Provider support matrix

| Driver        | Day-one status   | Observed CLI                                                       | In-app proof                                                                                                                                                                                                      |
| ------------- | ---------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex`       | **Usable**       | `codex-cli 0.147.0`; J5 discovery: installed, authenticated, ready | T2 completed a real J5 Codex turn with GPT-5.6-Sol and an exact response. A fresh ephemeral/read-only direct smoke also exited 0.                                                                                 |
| `claudeAgent` | **Usable**       | Claude Code 2.1.232; J5 discovery: installed, authenticated, ready | Fresh isolated J5 turn completed through `claudeAgent` / Claude Fable 5 in 9.8 s with exact response `J5 Claude provider smoke complete.` The durable run status is `completed`; both messages are non-streaming. |
| `cursor`      | Not usable today | CLI absent; J5 cache says not installed and driver disabled        | Not run; out of scope to install an unavailable provider.                                                                                                                                                         |
| `grok`        | Not usable today | CLI absent; J5 discovery reports `grok` not on PATH                | Not run.                                                                                                                                                                                                          |
| `opencode`    | Not usable today | CLI absent; J5 discovery reports `opencode` not on PATH            | Not run.                                                                                                                                                                                                          |

Claude Code displayed an available 2.1.233 update, but installed 2.1.232 passed the adapter smoke; no provider version was changed or globally pinned. Codex 0.147.0 also passed without a J5-specific version pin.

## Isolated Claude smoke evidence

The dev stack used explicit base `.t3/t6-provider-smoke`, server `127.0.0.1:13773`, and web `localhost:5733`. Its SQLite projection recorded:

- thread title `Claude Provider Smoke Test`
- default provider and provider instance `claudeAgent`
- run ordinal 1, status `completed`, with completion timestamp
- exact user prompt and assistant response, both `streaming = 0`

The tracked server was stopped with Ctrl-C and both ports were confirmed closed. Browser automation produced six temporary `.playwright-cli` evidence files; those were removed after database verification. Git status then contained only the two intended new T6 harness paths.

## Boundary

The harness enters at the production v2 command dispatcher rather than the MCP or WebSocket transport. It therefore isolates the executor/event-store question this ticket targeted, but does not measure transport overhead or full delegated-task lifecycle transitions. A future 24-hour soak or 30-real-provider-process test should be a separate, budgeted ticket; the current result does not justify an orchestrator fix or roadmap escalation.
