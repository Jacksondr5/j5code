import { assert, it } from "@effect/vitest";
import {
  EventId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { EventSinkV2, layer as eventSinkLayer } from "../../orchestration-v2/EventSink.ts";
import { layer as eventStoreLayer } from "../../orchestration-v2/EventStore.ts";
import {
  ProjectionMaintenanceV2,
  layer as projectionMaintenanceLayer,
} from "../../orchestration-v2/ProjectionMaintenance.ts";
import {
  ProjectionStoreV2,
  layer as projectionStoreLayer,
} from "../../orchestration-v2/ProjectionStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";

// Mirrors the store composition in orchestration-v2/FoundationPersistence.test.ts (FORK.md).
const databaseLayer = SqlitePersistenceMemory;
const eventStoreProvided = eventStoreLayer.pipe(Layer.provideMerge(databaseLayer));
const projectionStoreProvided = projectionStoreLayer.pipe(Layer.provideMerge(databaseLayer));
const storesProvided = Layer.mergeAll(databaseLayer, eventStoreProvided, projectionStoreProvided);
const eventSinkProvided = eventSinkLayer.pipe(Layer.provide(storesProvided));
const projectionMaintenanceProvided = projectionMaintenanceLayer.pipe(
  Layer.provide(storesProvided),
);
const TestLayer = Layer.mergeAll(storesProvided, eventSinkProvided, projectionMaintenanceProvided);

const providerInstanceId = ProviderInstanceId.make("codex");
const providerDriver = ProviderDriverKind.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

function makeThread(threadId: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make(`project:${threadId}`),
    title: `Thread ${threadId}`,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
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

function threadCreatedEvent(input: {
  readonly id: string;
  readonly thread: OrchestrationV2AppThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(input.id),
    type: "thread.created",
    threadId: input.thread.id,
    providerInstanceId,
    occurredAt: input.now,
    payload: input.thread,
  };
}

it.layer(TestLayer)("agent persona projection persistence", (it) => {
  it.effect("preserves the exact historical agent assignment through projection rebuilds", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const projectionStore = yield* ProjectionStoreV2;
      const maintenance = yield* ProjectionMaintenanceV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:foundation-agent-persona");
      const assignment = {
        personaId: "team-builder",
        definitionVersion: 3,
        definitionDigest: "a".repeat(64),
        displayName: "Original Team Builder",
        authorityPolicy: "workspace-write",
        resolvedRoute: "primary",
        resolvedDriver: providerDriver,
        resolvedModelSelection: modelSelection,
      } as const;
      const thread = { ...makeThread(threadId, now), agentPersonaAssignment: assignment };

      yield* eventSink.write({
        events: [threadCreatedEvent({ id: "event:foundation-agent-persona", thread, now })],
      });
      assert.deepEqual(
        (yield* projectionStore.getThreadProjection(threadId)).thread.agentPersonaAssignment,
        assignment,
      );
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(
        (yield* projectionStore.getThreadProjection(threadId)).thread.agentPersonaAssignment,
        assignment,
      );
    }),
  );
});
