import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointScopeId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  VcsProcessSpawnError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import { QueuedRunWatchdog } from "../j5/run-observability/QueuedRunWatchdog.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RunFinalization from "./RunFinalizationService.ts";

it.effect("captures the root checkpoint and refreshes workspace state", () => {
  const threadId = ThreadId.make("thread_finalize");
  const runId = RunId.make("run_finalize");
  const scopeId = CheckpointScopeId.make("scope_finalize");
  const capture = vi.fn(() => Effect.void);
  const refresh = vi.fn(() => Effect.void);
  const projection = {
    checkpointScopes: [{ id: scopeId, cwd: "/repo" }],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = RunFinalization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({ execute: capture }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () => Effect.succeed(projection),
        }),
        Layer.succeed(RunFinalization.RunFinalizationObserver, { refresh }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* RunFinalization.RunFinalizationService;
    yield* service.finalize({ threadId, runId, scopeId });
    assert.equal(capture.mock.calls.length, 1);
    assert.deepEqual(refresh.mock.calls[0], ["/repo"]);
  }).pipe(Effect.provide(layer));
});

it.effect("records a VCS observation for a checkpoint error wrapped by finalization", () => {
  const threadId = ThreadId.make("thread_finalize_checkpoint_vcs");
  const runId = RunId.make("run_finalize_checkpoint_vcs");
  const scopeId = CheckpointScopeId.make("scope_finalize_checkpoint_vcs");
  const vcsError = new VcsProcessTimeoutError({
    operation: "checkpoint.capture",
    command: "git",
    cwd: "/repo",
    timeoutMs: 5_000,
  });
  const capture = vi.fn((input) =>
    Effect.fail(
      new CheckpointCapture.CheckpointCaptureExecutionError({ ...input, cause: vcsError }),
    ),
  );
  const recordedCauses: Array<unknown> = [];
  const recordVcsFailure = vi.fn((input: { readonly cause: unknown }) =>
    Effect.sync(() => recordedCauses.push(input.cause)),
  );
  const layer = RunFinalization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({ execute: capture }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () =>
            Effect.die("projection must not be read after capture failure"),
        }),
        Layer.succeed(QueuedRunWatchdog, { scan: () => Effect.void, recordVcsFailure }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* RunFinalization.RunFinalizationService;
    const error = yield* service.finalize({ threadId, runId, scopeId }).pipe(Effect.flip);
    assert.instanceOf(error, RunFinalization.RunFinalizationError);
    assert.equal(recordedCauses.length, 1);
    assert.equal(recordedCauses[0], vcsError);
  }).pipe(Effect.provide(layer));
});

it.effect("records a VCS observation for a refresh error wrapped by finalization", () => {
  const threadId = ThreadId.make("thread_finalize_refresh_vcs");
  const runId = RunId.make("run_finalize_refresh_vcs");
  const scopeId = CheckpointScopeId.make("scope_finalize_refresh_vcs");
  const vcsError = new VcsProcessSpawnError({
    operation: "workspace.refresh",
    command: "git",
    cwd: "/repo",
    cause: new Error("spawn failed"),
  });
  const recordedCauses: Array<unknown> = [];
  const recordVcsFailure = vi.fn((input: { readonly cause: unknown }) =>
    Effect.sync(() => recordedCauses.push(input.cause)),
  );
  const projection = {
    checkpointScopes: [{ id: scopeId, cwd: "/repo" }],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = RunFinalization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({ execute: () => Effect.void }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () => Effect.succeed(projection),
        }),
        Layer.succeed(RunFinalization.RunFinalizationObserver, {
          refresh: () =>
            Effect.fail(
              new RunFinalization.RunFinalizationRefreshError({ cwd: "/repo", cause: vcsError }),
            ),
        }),
        Layer.succeed(QueuedRunWatchdog, { scan: () => Effect.void, recordVcsFailure }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* RunFinalization.RunFinalizationService;
    const error = yield* service.finalize({ threadId, runId, scopeId }).pipe(Effect.flip);
    assert.instanceOf(error, RunFinalization.RunFinalizationError);
    assert.equal(recordedCauses.length, 1);
    assert.equal(recordedCauses[0], vcsError);
  }).pipe(Effect.provide(layer));
});
