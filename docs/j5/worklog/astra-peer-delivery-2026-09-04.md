# Astra peer delivery — September 4, 2026

Jackson authorized an Astra-only QS1 exception and direct implementation by the coordinator. No peer or subagent was staffed or contacted. Base: `9209e0b3b53fb98591b958077848ffdabee07b49`; branch: `j5/astra-peer-delivery`.

## Change

The J5 delivery transport selects an eligible live Codex Astra run using the existing `latestSteerableRun`, the active run's model, the shared model alias normalizer, and the session's active-steering capability. It sends a run-pinned `message.dispatch / steer_active` command through the existing orchestrator. Queue delivery continues through ThreadManagementService for other models and unavailable turns. No upstream orchestration or adapter source changes, schema changes, migration, settings, or new scheduler.

A direct run-pinned command is necessary: ThreadManagementService's `steer` mode reselects the latest steerable run, which could change between reads; its `auto` mode is not a guarantee of native steering. Carrying the active run's model selection prevents an unrelated picker change from selecting upstream's interrupt-and-restart path.

Each steered message carries platform guidance to preserve the unfinished user objective while incorporating relevant information. Peer authority and human authority remain distinct. Platform notices retain queue delivery.

## Evidence and limits

Focused integration coverage uses real in-memory SQLite, the real delivery transport, serialized orchestrator, effect worker, and provider-control service, terminating at a fake Codex provider adapter. It proves active-turn delivery and tool-result retention in the app, not Astra's reasoning quality or the behavior of an installed Codex binary.

Scenarios cover canonical Astra and its alias; idle delivery; preparing/no-live-turn eligibility; non-Astra models and a non-Codex driver; missing/unsupported sessions; picker changes; a clarification and a reply during an unfinished tool; stable-ID retry deduplication; system notices remaining queued; and a turn-ending race rejected without interrupting or redirecting to another run. Existing non-Astra queue/tool-sibling and human-inbox tests remain in the focused suite.

The outbox's existing scheduling is inherited. With a fixed test clock, two effects can reach the adapter in effect-ID order rather than message submission order; the test asserts both distinct messages arrive exactly once and makes no new FIFO guarantee. No batching or queue-ordering change is included.

A stale steer target follows the existing durable rejection/retry/alarm path. No command-ID rotation, silent retry as a different command, or restart fallback is added. Previously queued messages are not automatically promoted.

Live acceptance remains: while Astra performs a long build, deliver a relevant clarification, an answer to its question, and an unrelated update; verify useful context arrives promptly, the original objective remains active, and real tool calls/results survive. No live A2A traffic, provider run, server restart, or browser session was used for this build.

## Completed checks

Node 24.20.0, pnpm 11.10.0. The five focused files (`DeliveryTransport.integration`, `DeliveryTransport.channel`, `DeliveryWorker`, `HumanInboxService`, and `runtimeLayer`) pass all 23 tests. Server `tsgo --noEmit -p apps/server/tsconfig.json` exits 0; scoped Vite Plus lint exits 0; `git diff --check` passes. Logs: `/tmp/astra-peer-tests.log`, `/tmp/astra-peer-typecheck.log`, `/tmp/astra-peer-lint.log`. No repo-wide checks were run.
