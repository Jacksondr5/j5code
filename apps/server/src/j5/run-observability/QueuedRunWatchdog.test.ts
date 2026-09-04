import {
  ProviderInstanceId,
  VcsProcessExitError,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, it } from "vite-plus/test";

import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import { QueuedRunCandidates, type CandidateQuery } from "./QueuedRunCandidates.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import {
  layer,
  QueuedRunWatchdog,
  QUEUED_RUN_WATCHDOG_DELAY_MS,
  QUEUED_RUN_WATCHDOG_MAX_CANDIDATES,
} from "./QueuedRunWatchdog.ts";

it("records one durable waiting fact for a promoted run that has not dispatched", async () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread_queued_run_watchdog");
    const runId = RunId.make("run_queued_run_watchdog");
    const now = yield* DateTime.now;
    const run = {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId: ProviderInstanceId.make("codex"),
      status: "starting",
      startedAt: null,
      requestedAt: DateTime.makeUnsafe(DateTime.toEpochMillis(now) - QUEUED_RUN_WATCHDOG_DELAY_MS),
      activeAttemptId: RunAttemptId.make("attempt_queued_run_watchdog"),
      rootNodeId: null,
      providerThreadId: null,
      modelSelection: { model: "gpt-5.4" },
      userMessageId: "message_queued_run_watchdog",
      queuePosition: null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };
    const turnItems: Array<OrchestrationV2ThreadProjection["turnItems"][number]> = [];
    const projection = {
      thread: { id: threadId },
      runs: [run],
      turnItems,
    } as unknown as OrchestrationV2ThreadProjection;
    const written: Array<unknown> = [];
    const runQueries: Array<{
      readonly status: string;
      readonly requestedBefore: DateTime.Utc;
      readonly limit: number;
    }> = [];
    const projectionReadIds: Array<ThreadId> = [];
    const testLayer = layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(QueuedRunCandidates)({
            list: (input) =>
              Effect.sync(() => {
                runQueries.push(input);
                return projection.runs;
              }),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadProjection: (id) =>
              Effect.sync(() => {
                projectionReadIds.push(id);
                return projection;
              }),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            writeIfRunCurrent: (input) =>
              Effect.sync(() => {
                written.push(input);
                const event = input.events[0];
                if (event?.type === "turn-item.updated") turnItems.push(event.payload);
                return { committed: true, storedEvents: [] } as never;
              }),
          }),
          IdAllocator.layer,
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const watchdog = yield* QueuedRunWatchdog;
      yield* watchdog.scan();
      yield* watchdog.scan();
    }).pipe(Effect.provide(testLayer));

    expect(written).toHaveLength(1);
    expect(runQueries).toHaveLength(2);
    expect(runQueries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "starting",
          limit: QUEUED_RUN_WATCHDOG_MAX_CANDIDATES,
        }),
      ]),
    );
    expect(projectionReadIds).toEqual([threadId, threadId]);
    const event = (written[0] as { events: Array<unknown> }).events[0] as {
      readonly type: string;
      readonly payload: {
        readonly title: string | null;
        readonly status: string;
        readonly failure: { readonly message: string; readonly code: string | null };
      };
    };
    expect(event.type).toBe("turn-item.updated");
    expect(event.payload).toMatchObject({
      title: "Run waiting",
      status: "completed",
      failure: { code: "queued_run_waiting", message: "Run waiting 5m, not yet dispatched." },
    });
  }).pipe(Effect.runPromise));

it("advances a bounded watchdog scan past the first 100 stale runs", async () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread_queued_run_watchdog_fairness");
    const now = yield* DateTime.now;
    const requestedAt = DateTime.makeUnsafe(
      DateTime.toEpochMillis(now) - QUEUED_RUN_WATCHDOG_DELAY_MS,
    );
    const staleRuns = Array.from(
      { length: QUEUED_RUN_WATCHDOG_MAX_CANDIDATES + 1 },
      (_, index) => ({
        id: RunId.make(`run_queued_run_watchdog_fairness_${String(index).padStart(3, "0")}`),
        threadId,
        ordinal: index + 1,
        providerInstanceId: ProviderInstanceId.make("codex"),
        status: "starting" as const,
        startedAt: null,
        requestedAt,
        activeAttemptId: RunAttemptId.make(`attempt_queued_run_watchdog_fairness_${index}`),
        rootNodeId: null,
        providerThreadId: null,
        modelSelection: { model: "gpt-5.4" },
        userMessageId: `message_queued_run_watchdog_fairness_${index}`,
        queuePosition: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      }),
    );
    const projection = {
      thread: { id: threadId },
      runs: staleRuns,
      turnItems: [],
    } as unknown as OrchestrationV2ThreadProjection;
    const queries: Array<CandidateQuery> = [];
    const observedRunIds: Array<RunId> = [];
    const testLayer = layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(QueuedRunCandidates)({
            list: (input) =>
              Effect.sync(() => {
                queries.push(input);
                return projection.runs
                  .filter(
                    (run) =>
                      input.after === undefined || String(run.id) > String(input.after.runId),
                  )
                  .slice(0, input.limit);
              }),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            writeIfRunCurrent: (input) =>
              Effect.sync(() => {
                const event = input.events[0];
                if (event?.type === "turn-item.updated" && event.runId !== undefined) {
                  observedRunIds.push(event.runId);
                }
                return { committed: true, storedEvents: [] } as never;
              }),
          }),
          IdAllocator.layer,
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const watchdog = yield* QueuedRunWatchdog;
      yield* watchdog.scan();
      yield* watchdog.scan();
    }).pipe(Effect.provide(testLayer));

    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatchObject({ limit: QUEUED_RUN_WATCHDOG_MAX_CANDIDATES });
    expect(queries[1]?.after).toEqual({
      requestedAt,
      runId: staleRuns[QUEUED_RUN_WATCHDOG_MAX_CANDIDATES - 1]?.id,
    });
    expect(observedRunIds).toContain(staleRuns[QUEUED_RUN_WATCHDOG_MAX_CANDIDATES]?.id);
  }).pipe(Effect.runPromise));

it("records one sanitized VCS observation fact without changing the run", async () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread_vcs_observation");
    const runId = RunId.make("run_vcs_observation");
    const now = yield* DateTime.now;
    const run = {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId: ProviderInstanceId.make("codex"),
      status: "starting",
      startedAt: null,
      requestedAt: now,
      activeAttemptId: RunAttemptId.make("attempt_vcs_observation"),
      rootNodeId: null,
      providerThreadId: null,
      modelSelection: { model: "gpt-5.4" },
      userMessageId: "message_vcs_observation",
      queuePosition: null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };
    const turnItems: Array<OrchestrationV2ThreadProjection["turnItems"][number]> = [];
    const projection = {
      thread: { id: threadId },
      runs: [run],
      turnItems,
    } as unknown as OrchestrationV2ThreadProjection;
    const written: Array<unknown> = [];
    const testLayer = layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            write: (input) =>
              Effect.sync(() => {
                written.push(input);
                const event = input.events[0];
                if (event?.type === "turn-item.updated") turnItems.push(event.payload);
                return [] as never;
              }),
          }),
          Layer.mock(QueuedRunCandidates)({}),
          IdAllocator.layer,
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const watchdog = yield* QueuedRunWatchdog;
      const input = {
        threadId,
        runId,
        phase: "start" as const,
        cause: new VcsProcessExitError({
          operation: "start",
          command: "git",
          cwd: "/repo",
          exitCode: 1,
          detail: "credential secret=should-not-reach-the-timeline",
        }),
      };
      yield* watchdog.recordVcsFailure(input);
      yield* watchdog.recordVcsFailure(input);
    }).pipe(Effect.provide(testLayer));

    expect(written).toHaveLength(1);
    const event = (written[0] as { events: Array<unknown> }).events[0] as {
      readonly type: string;
      readonly payload: {
        readonly status: string;
        readonly title: string | null;
        readonly failure: { readonly message: string; readonly code: string | null };
      };
    };
    expect(event.type).toBe("turn-item.updated");
    expect(event.payload).toMatchObject({
      status: "completed",
      title: "Run start delayed",
      failure: { code: "vcs_start_failure" },
    });
    expect(event.payload.failure.message).toContain("secret=[REDACTED]");
    expect(event.payload.failure.message).not.toContain("should-not-reach-the-timeline");
  }).pipe(Effect.runPromise));
