import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { EventSinkV2, layer as eventSinkLayer } from "../../orchestration-v2/EventSink.ts";
import { layer as eventStoreLayer } from "../../orchestration-v2/EventStore.ts";
import { layer as idAllocatorLayer } from "../../orchestration-v2/IdAllocator.ts";
import {
  ProjectionMaintenanceV2,
  layer as projectionMaintenanceLayer,
} from "../../orchestration-v2/ProjectionMaintenance.ts";
import {
  ProjectionStoreV2,
  layer as projectionStoreLayer,
} from "../../orchestration-v2/ProjectionStore.ts";
import {
  NativeThreadValidationError,
  ThreadRepointService,
  layer,
} from "./ThreadRepointService.ts";

const database = SqlitePersistenceMemory;
const eventStore = eventStoreLayer.pipe(Layer.provideMerge(database));
const projections = projectionStoreLayer.pipe(Layer.provideMerge(database));
const stores = Layer.mergeAll(database, eventStore, projections);
const eventSink = eventSinkLayer.pipe(Layer.provide(stores));
const maintenance = projectionMaintenanceLayer.pipe(Layer.provide(stores));
const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const selection = { instanceId: providerInstanceId, model: "gpt-5.4" } satisfies ModelSelection;

function thread(threadId: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make(`project:${threadId}`),
    title: "Repair target",
    providerInstanceId,
    modelSelection: selection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: "/workspace/repair-target",
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

const seed = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sink = yield* EventSinkV2;
    const now = yield* DateTime.now;
    const appThread = thread(threadId, now);
    const providerThreadId = ProviderThreadId.make(`provider-thread:${threadId}`);
    const providerThread = {
      id: providerThreadId,
      driver,
      providerInstanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: { driver, nativeId: "old-native", strength: "strong" as const },
      nativeConversationHeadRef: null,
      status: "idle" as const,
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      createdAt: now,
      updatedAt: now,
    };
    yield* sink.write({
      events: [
        {
          id: EventId.make(`event:${threadId}:created`),
          type: "thread.created",
          threadId,
          providerInstanceId,
          occurredAt: now,
          payload: { ...appThread, activeProviderThreadId: providerThreadId },
        },
        {
          id: EventId.make(`event:${threadId}:provider-thread`),
          type: "provider-thread.updated",
          threadId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: providerThread,
        },
      ],
    });
  });

it.layer(Layer.mergeAll(stores, eventSink, idAllocatorLayer, maintenance))(
  "thread repoint",
  (it) => {
    it.effect(
      "writes through EventSink, advances metadata without rebuild, and records a timeline fact",
      () =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("thread:repoint-event-sink");
          yield* seed(threadId);
          const serviceLayer = layer(() => Effect.void).pipe(
            Layer.provide(Layer.mergeAll(eventSink, idAllocatorLayer, projections)),
          );
          yield* Effect.gen(function* () {
            const service = yield* ThreadRepointService;
            yield* service.repoint({ threadId, nativeId: "new-native" });
          }).pipe(Effect.provide(serviceLayer));

          const projectionStore = yield* ProjectionStoreV2;
          const projection = yield* projectionStore.getThreadProjection(threadId);
          assert.equal(projection.providerThreads[0]?.nativeThreadRef?.nativeId, "new-native");
          assert.equal(projection.turnItems.at(-1)?.title, "Native thread repointed");
          const projectionMaintenance = yield* ProjectionMaintenanceV2;
          assert.equal((yield* projectionMaintenance.verify).valid, true);
        }),
    );

    it.effect("refuses a native id that fails validation before it writes", () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread:repoint-invalid-native");
        yield* seed(threadId);
        const serviceLayer = layer(
          () => new NativeThreadValidationError({ detail: "probe refused this native id" }),
        ).pipe(Layer.provide(Layer.mergeAll(eventSink, idAllocatorLayer, projections)));
        const refusal = yield* Effect.gen(function* () {
          const service = yield* ThreadRepointService;
          return yield* service.repoint({ threadId, nativeId: "missing-native" }).pipe(Effect.flip);
        }).pipe(Effect.provide(serviceLayer));
        assert.include(refusal.message, "did not validate");
        const projectionStore = yield* ProjectionStoreV2;
        assert.equal((yield* projectionStore.getThreadProjection(threadId)).turnItems.length, 0);
      }),
    );
  },
);

it.effect("refuses a target with a nonterminal run before validating or writing", () => {
  const threadId = ThreadId.make("thread:repoint-running");
  const serviceLayer = layer(() => Effect.void).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(EventSinkV2)({}),
        Layer.mock(ProjectionStoreV2)({
          getThreadProjection: () =>
            Effect.succeed({
              runs: [{ id: "run:active", status: "running" }],
              providerThreads: [],
              thread: { activeProviderThreadId: null },
            } as never),
        }),
        idAllocatorLayer,
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* ThreadRepointService;
    const refusal = yield* service.repoint({ threadId, nativeId: "native" }).pipe(Effect.flip);
    assert.include(refusal.message, "wait for it to settle");
  }).pipe(Effect.provide(serviceLayer));
});
