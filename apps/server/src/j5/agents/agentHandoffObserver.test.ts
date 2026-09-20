import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ArtifactEntry,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../../config.ts";
import { EventSinkV2, layer as eventSinkLayer } from "../../orchestration-v2/EventSink.ts";
import { layer as eventStoreLayer } from "../../orchestration-v2/EventStore.ts";
import {
  ProjectionStoreV2,
  layer as projectionStoreLayer,
} from "../../orchestration-v2/ProjectionStore.ts";
import * as RunFinalization from "../../orchestration-v2/RunFinalizationService.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ArtifactWorkspace } from "../artifacts/ArtifactWorkspace.ts";
import { AgentHandoffNudgeQueue, layer as queueLayer } from "./agentHandoffNudgeQueue.ts";
import { layer as observerLayer } from "./agentHandoffObserver.ts";
import { AgentHandoffRefreshes, layer as refreshesLayer } from "./agentHandoffRefreshes.ts";
import { makeAgentHandoffStore } from "./agentHandoffStore.ts";
import { agentHandoffNudgeText } from "./agentHandoffNudgeWorker.ts";
import { agentHandoffArtifactPath } from "./agentPersonaArtifacts.ts";
import { createAgentPersonaLibrary, definitionDigest } from "./agentPersonaLibrary.ts";
import { BUILT_IN_AGENT_PERSONAS } from "./agentPersonas.ts";

class ArtifactEntries extends Context.Service<
  ArtifactEntries,
  Ref.Ref<ReadonlyArray<ArtifactEntry>>
>()("t3/j5/agents/agentHandoffObserver.test/ArtifactEntries") {}
const artifactEntriesLayer = Layer.effect(
  ArtifactEntries,
  Ref.make<ReadonlyArray<ArtifactEntry>>([]),
);

const fakeArtifacts = Layer.effect(
  ArtifactWorkspace,
  Effect.gen(function* () {
    const entries = yield* ArtifactEntries;
    const unsupported = Effect.die("not used by the handoff observer");
    return ArtifactWorkspace.of({
      prepare: () => Effect.void,
      list: () => Ref.get(entries),
      read: () => unsupported,
      write: () => unsupported,
      writeVersioned: () => unsupported,
      exportPlan: () => unsupported,
      watch: () => {
        throw new Error("not used");
      },
    });
  }),
);

const databaseLayer = SqlitePersistenceMemory;
const stores = Layer.mergeAll(
  databaseLayer,
  eventStoreLayer.pipe(Layer.provideMerge(databaseLayer)),
  projectionStoreLayer.pipe(Layer.provideMerge(databaseLayer)),
);
const config = ServerConfig.layerTest(process.cwd(), { prefix: "j5-agent-handoff-" }).pipe(
  Layer.provide(NodeServices.layer),
);
// Infrastructure is one composite so the queue and the artifact entry ref are shared by reference
// between the observer under test and the assertions.
const infrastructure = Layer.mergeAll(
  queueLayer,
  refreshesLayer,
  artifactEntriesLayer,
  stores,
  config,
  NodeServices.layer,
);
const fakeArtifactsProvided = fakeArtifacts.pipe(Layer.provide(artifactEntriesLayer));
const TestLayer = Layer.mergeAll(
  observerLayer.pipe(Layer.provide(fakeArtifactsProvided), Layer.provide(infrastructure)),
  eventSinkLayer.pipe(Layer.provide(stores)),
).pipe(Layer.provideMerge(infrastructure));

const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.6-terra",
} satisfies ModelSelection;

it.effect("records written handoffs, nudges once for a missing one, then keeps it missing", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const library = createAgentPersonaLibrary({ stateDir: serverConfig.stateDir, fs, path });
    const definition = BUILT_IN_AGENT_PERSONAS.critic;
    const digest = yield* library.snapshot(definition);
    assert.equal(digest, definitionDigest(definition));

    const eventSink = yield* EventSinkV2;
    const projections = yield* ProjectionStoreV2;
    const observer = yield* RunFinalization.RunFinalizationObserver;
    const nudges = yield* AgentHandoffNudgeQueue;
    const refreshes = yield* AgentHandoffRefreshes;
    const entries = yield* ArtifactEntries;
    const store = yield* makeAgentHandoffStore;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("critic-task-0001");
    const projectId = ProjectId.make("project");
    const thread: OrchestrationV2AppThread = {
      createdBy: "agent",
      creationSource: "mcp",
      id: threadId,
      projectId,
      title: "Critic",
      providerInstanceId,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
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
      agentPersonaAssignment: {
        personaId: definition.id,
        definitionVersion: definition.version,
        definitionDigest: digest,
        displayName: definition.displayName,
        authorityPolicy: "critic-review",
        resolvedRoute: "primary",
        resolvedDriver: ProviderDriverKind.make("codex"),
        resolvedModelSelection: modelSelection,
      },
    };
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("critic-created"),
          type: "thread.created",
          threadId,
          providerInstanceId,
          occurredAt: now,
          payload: thread,
        },
      ],
    });
    const runId = RunId.make("critic-run-1");
    const refresh = { cwd: "/tmp", threadId, runId };
    const expectedPath = agentHandoffArtifactPath({
      personaId: "critic",
      artifact: "ReviewHandoff",
      threadId,
    });

    // While the run is still waiting (checkpoint capture has not committed completion yet) the
    // observer records nothing; this guard keeps the check off the pre-checkpoint path.
    const run = {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make("critic-message-1"),
      rootNodeId: NodeId.make("critic-node-1"),
      activeAttemptId: null,
      status: "waiting" as const,
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };
    const runEvent = (
      id: string,
      type: "run.created" | "run.updated",
      status: "waiting" | "completed",
    ) => ({
      id: EventId.make(id),
      type,
      threadId,
      runId,
      nodeId: run.rootNodeId,
      driver: ProviderDriverKind.make("codex"),
      occurredAt: now,
      payload: { ...run, status, completedAt: status === "completed" ? now : null },
    });
    yield* eventSink.write({
      events: [runEvent("critic-run-1-created", "run.created", "waiting")],
    });
    yield* observer.refresh(refresh);
    assert.isNull(yield* store.get(threadId));
    assert.equal(yield* Queue.size(nudges), 0);
    assert.equal(yield* SubscriptionRef.get(refreshes), 0);

    // First completion without the artifact: one nudge, status nudged, one refresh signal.
    yield* eventSink.write({
      events: [runEvent("critic-run-1-completed", "run.updated", "completed")],
    });
    yield* observer.refresh(refresh);
    assert.equal((yield* store.get(threadId))?.status, "nudged");
    assert.equal((yield* store.get(threadId))?.path, expectedPath);
    const nudge = yield* Queue.take(nudges);
    assert.equal(nudge.threadId, threadId);
    assert.include(agentHandoffNudgeText(nudge), `\`${expectedPath}\``);
    assert.equal(yield* SubscriptionRef.get(refreshes), 1);

    // The follow-up run ends without it too: missing, and no second nudge.
    yield* observer.refresh({ ...refresh, runId: RunId.make("critic-run-2") });
    assert.equal((yield* store.get(threadId))?.status, "missing");
    assert.equal(yield* Queue.size(nudges), 0);

    // Missing is terminal for reminders: a third empty run stays missing and is never re-nudged.
    yield* observer.refresh({ ...refresh, runId: RunId.make("critic-run-2b") });
    assert.equal((yield* store.get(threadId))?.status, "missing");
    assert.equal(yield* Queue.size(nudges), 0);
    assert.equal(yield* SubscriptionRef.get(refreshes), 3);

    // Once the file exists, the status flips to written.
    yield* Ref.set(entries, [{ path: expectedPath, byteLength: 12, modifiedAt: null }]);
    yield* observer.refresh({ ...refresh, runId: RunId.make("critic-run-3") });
    const written = yield* store.get(threadId);
    assert.equal(written?.status, "written");
    assert.equal(written?.runId, "critic-run-3");
    assert.deepEqual(
      (yield* store.list({ threadIds: [threadId] })).map(({ status }) => status),
      ["written"],
    );

    // Threads without a saved agent are ignored.
    const plainId = ThreadId.make("plain-task");
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("plain-created"),
          type: "thread.created",
          threadId: plainId,
          providerInstanceId,
          occurredAt: now,
          payload: {
            ...thread,
            id: plainId,
            agentPersonaAssignment: undefined,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: plainId },
          },
        },
      ],
    });
    yield* observer.refresh({ cwd: "/tmp", threadId: plainId, runId: RunId.make("plain-run") });
    assert.isNull(yield* store.get(plainId));
    assert.equal(yield* SubscriptionRef.get(refreshes), 4);
    assert.isNotNull(yield* projections.getThreadProjection(plainId));
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);
