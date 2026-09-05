# Astra peer delivery — September 4, 2026

Jackson authorized an Astra-only QS1 exception and direct implementation by the coordinator. No peer or subagent was staffed or contacted. Base: `9209e0b3b53fb98591b958077848ffdabee07b49`; branch: `j5/astra-peer-delivery`.

## Change

The J5 delivery transport selects an eligible live Codex Astra run using the existing `latestSteerableRun`, the active run's model, the shared model alias normalizer, and the session's active-steering capability. It sends a run-pinned `message.dispatch / steer_active` command through the existing orchestrator. Queue delivery continues through ThreadManagementService for other models and unavailable turns. No wire schema change, migration, settings, or new scheduler. Three small orchestration edits supply a durable effect receipt, expose the existing outbox instance to J5, and reject steering a turn that has already ended; provider adapters are unchanged.

A direct run-pinned command is necessary: ThreadManagementService's `steer` mode reselects the latest steerable run, which could change between reads; its `auto` mode is not a guarantee of native steering. Carrying the active run's model selection prevents an unrelated picker change from selecting upstream's interrupt-and-restart path.

Each steered message carries platform guidance to preserve the unfinished user objective while incorporating relevant information. Peer authority and human authority remain distinct. Platform notices retain queue delivery.

## Evidence and limits

Focused integration coverage uses real in-memory SQLite, the real delivery transport, serialized orchestrator, effect worker, and provider-control service, terminating at a fake Codex provider adapter. It proves active-turn delivery and tool-result retention in the app, not Astra's reasoning quality or the behavior of an installed Codex binary.

Scenarios cover canonical Astra and its alias; idle delivery; preparing/no-live-turn eligibility; non-Astra models and a non-Codex driver; missing/unsupported sessions; picker changes; a clarification and a reply during an unfinished tool; stable-ID retry deduplication; system notices remaining queued; and turn-ending races before dispatch and after commit, both rejected without interrupting or redirecting to another run. The transport waits for a successful native-steer effect before recording delivery; failed or cancelled effects retain the existing retry/alarm behavior. Retries inspect the same durable effect even after the run ends, and a previously accepted queued delivery stays accepted when its Astra run starts. Existing non-Astra queue/tool-sibling and human-inbox tests remain in the focused suite.

The outbox's existing scheduling is inherited. With a fixed test clock, two effects can reach the adapter in effect-ID order rather than message submission order; the test asserts both distinct messages arrive exactly once and makes no new FIFO guarantee. No batching or queue-ordering change is included.

A stale steer target follows the existing durable rejection/retry/alarm path. No command-ID rotation, silent retry as a different command, or restart fallback is added. Previously queued messages are not automatically promoted.

Jackson exercised two real registered-peer trials on the isolated server at `2ebb2db776613483633cef9d8021408bc0af7532`. On September 5 UTC, messages committed at 02:26:43.368 and 02:29:25.730 reached successful native steer effects 30 ms and 36 ms later. The same Astra runs replied after 19.416 s and 20.227 s, before ending normally. Each retained one initial attempt and one native provider turn, with no interrupt/restart or additional queued run. Reply text continued the original analysis. Full read-only evidence is retained locally in `/tmp/astra-peer-live-verification/`; the live server remains pinned to that commit.

Those trials establish useful mid-turn delivery and task continuity, not precise overlap with a long-running native tool batch. The subsequent receipt/race fix is covered by the real SQLite/orchestrator/worker integration fixture; it has not been exercised with a second real-provider browser session. No build agents were staffed.

## Receipt boundary

`EffectOutbox.awaitSettled` subscribes before checking the durable row, then waits on settlement notifications instead of polling. Success, terminal failure, archive cancellation and process-loss cancellation all wake subscribers; already-settled rows return immediately. J5 shares the worker's outbox instance. A retry never re-injects a different command after an ambiguous outcome.

The post-commit regression first reproduced false success with zero adapter calls. It now requires a typed delivery error after the real worker exhausts its five attempts using controlled time, then retries the same A2A ID twice and verifies no extra message or run. Existing effect-worker settlement/recovery tests remain part of the focused verification.

## Completed checks

Node 24.20.0, pnpm 11.10.0. Focused verification covers the five J5 delivery/inbox/runtime files plus EffectOutbox, ProviderTurnControlService, EffectWorker and FoundationPersistence. Checks and final results are recorded on the PR. No repo-wide checks run locally; CI owns the full suite.
