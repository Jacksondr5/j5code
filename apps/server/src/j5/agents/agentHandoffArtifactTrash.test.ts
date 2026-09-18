import { ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  AgentHandoffArtifactTrash,
  layer as artifactTrashLayer,
} from "./agentHandoffArtifactTrash.ts";
import { AgentHandoffRefreshes, layer as refreshesLayer } from "./agentHandoffRefreshes.ts";
import { makeAgentHandoffStore } from "./agentHandoffStore.ts";

const infrastructure = Layer.mergeAll(SqlitePersistenceMemory, refreshesLayer);
const TestLayer = artifactTrashLayer.pipe(
  Layer.provide(infrastructure),
  Layer.provideMerge(infrastructure),
);

it.effect("marks a trashed handoff missing and publishes one refresh", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:handoff-trash");
    const threadId = ThreadId.make("thread:handoff-trash");
    const path = "handoffs/critic/ReviewHandoff-trash.md";
    const store = yield* makeAgentHandoffStore;
    const refreshes = yield* AgentHandoffRefreshes;
    const reconciler = yield* AgentHandoffArtifactTrash;
    yield* store.upsert({
      threadId,
      projectId,
      personaId: "critic",
      artifact: "ReviewHandoff",
      path,
      status: "written",
      runId: null,
      checkedAt: "2026-09-17T00:00:00.000Z",
    });

    const before = yield* SubscriptionRef.get(refreshes);
    yield* reconciler.reconcile({ projectId, path });

    assert.equal((yield* store.get(threadId))?.status, "missing");
    assert.equal(yield* SubscriptionRef.get(refreshes), before + 1);
  }).pipe(Effect.provide(TestLayer)),
);
