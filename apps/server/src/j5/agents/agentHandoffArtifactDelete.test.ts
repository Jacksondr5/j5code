import { ProjectId, ThreadId, RunId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  AgentHandoffArtifactDelete,
  layer as artifactDeleteLayer,
} from "./agentHandoffArtifactDelete.ts";
import { AgentHandoffRefreshes, layer as refreshesLayer } from "./agentHandoffRefreshes.ts";
import { makeAgentHandoffStore } from "./agentHandoffStore.ts";

const infrastructure = Layer.mergeAll(SqlitePersistenceMemory, refreshesLayer);
const TestLayer = artifactDeleteLayer.pipe(
  Layer.provide(infrastructure),
  Layer.provideMerge(infrastructure),
);

it.effect("marks a deleted handoff missing and publishes one refresh", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:handoff-delete");
    const threadId = ThreadId.make("thread:handoff-delete");
    const path = "handoffs/critic/ReviewHandoff-delete.md";
    const store = yield* makeAgentHandoffStore;
    const refreshes = yield* AgentHandoffRefreshes;
    const reconciler = yield* AgentHandoffArtifactDelete;
    yield* store.upsert({
      threadId,
      projectId,
      personaId: "critic",
      artifact: "ReviewHandoff",
      path,
      status: "written",
      runId: RunId.make("run:latest"),
      checkedAt: "2026-09-17T00:00:00.000Z",
    });

    const before = yield* SubscriptionRef.get(refreshes);
    yield* reconciler.reconcile({ projectId, path });

    assert.equal((yield* store.get(threadId))?.status, "missing");
    assert.equal((yield* store.get(threadId))?.runId, "run:latest");
    assert.equal(yield* SubscriptionRef.get(refreshes), before + 1);
    yield* reconciler.reconcile({ projectId, path });
    yield* reconciler.reconcile({ projectId: ProjectId.make("project:other"), path });
    assert.equal(yield* SubscriptionRef.get(refreshes), before + 1);
  }).pipe(Effect.provide(TestLayer)),
);
