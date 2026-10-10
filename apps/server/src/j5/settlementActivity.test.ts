import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { resolveAutoSettlementAt } from "../orchestration-v2/ThreadSettlementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { deliveryMessageId } from "./a2a/DeliveryTransport.ts";
import { LedgerMessageId } from "./a2a/contracts.ts";

const stores = [
  ["sql", ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))],
  ["memory", ProjectionStore.layerMemory],
] as const;

const now = DateTime.makeUnsafe("2026-10-09T12:00:00Z");
const created = DateTime.subtract(now, { days: 10 });
const merged = DateTime.subtract(now, { hours: 2 });
const afterMerge = DateTime.subtract(now, { hours: 1 });
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "test-model" };

/** A thread an agent spawned: no person has written to it, and its pull request has merged. */
const spawnedThread = Effect.fn(function* (name: string) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = ThreadId.make(`thread:settlement-activity:${name}`);
  const thread: OrchestrationV2AppThread = {
    createdBy: "agent",
    creationSource: "mcp",
    id: threadId,
    projectId: ProjectId.make("project:settlement-activity"),
    title: name,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: created,
    updatedAt: created,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  yield* store.apply({
    id: EventId.make(`event:${threadId}`),
    type: "thread.created",
    threadId,
    occurredAt: created,
    payload: thread,
  });
  return threadId;
});

type Marker = Pick<OrchestrationV2ConversationMessage, "createdBy" | "creationSource"> &
  Partial<Pick<OrchestrationV2ConversationMessage, "id" | "scheduledTaskId" | "notification">>;

const receive = Effect.fn(function* (threadId: ThreadId, marker: Marker, at: DateTime.Utc) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  yield* store.apply({
    id: EventId.make(`event:${threadId}:message`),
    type: "message.updated",
    threadId,
    occurredAt: at,
    payload: {
      id: MessageId.make(`message:${threadId}`),
      threadId,
      runId: null,
      nodeId: null,
      role: "user",
      text: "message",
      attachments: [],
      streaming: false,
      createdAt: at,
      updatedAt: at,
      ...marker,
    },
  });
});

/** What auto-settle decides for the thread at `at`, with a two-day idle window. */
const settlesAt = Effect.fn(function* (threadId: ThreadId, at: DateTime.Utc) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const [thread] = yield* store.getSettlementCandidates(threadId);
  assert.isDefined(thread);
  return resolveAutoSettlementAt({
    thread,
    pullRequest: { state: "merged", mergedAt: DateTime.formatIso(merged) },
    nowMs: DateTime.toEpochMillis(at),
    autoSettleAfterDays: 2,
    autoSettleOnMerge: true,
  });
});

const delivery: Marker = {
  id: deliveryMessageId(LedgerMessageId.make("ledger-message-1")),
  createdBy: "agent",
  creationSource: "mcp",
};

it.effect.each(stores)(
  "%s: an agent-to-agent delivery after the merge holds the thread until it goes idle",
  ([, testLayer]) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* spawnedThread("delivery");
      assert.deepEqual(yield* settlesAt(threadId, now), created);

      yield* receive(threadId, delivery, afterMerge);
      assert.isNull(yield* settlesAt(threadId, now));
      // Once the idle window has passed since the delivery, the thread settles like any other.
      assert.deepEqual(
        yield* settlesAt(threadId, DateTime.add(afterMerge, { days: 2, minutes: 1 })),
        afterMerge,
      );
      // The shell's stamp still means a person's message: it orders upstream's Working section.
      const shell = (yield* store.getShellSnapshot()).threads.find((item) => item.id === threadId);
      assert.isNull(shell!.latestUserAuthoredMessageAt);
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each(
  stores.flatMap(([store, testLayer]) =>
    (
      [
        ["a person's Inbox answer", { ...delivery, createdBy: "user" }, false],
        ["a spawn brief", { createdBy: "agent", creationSource: "mcp" }, false],
        [
          "a pull-request watch wake",
          {
            createdBy: "agent",
            creationSource: "server",
            notification: {
              source: { kind: "background_task" },
              outcome: "updated",
              summary: "Pull request updated",
            },
          },
          true,
        ],
        [
          "a run of a task an agent scheduled",
          {
            createdBy: "agent",
            creationSource: "mcp",
            scheduledTaskId: ScheduledTaskId.make("scheduled-task-1"),
          },
          true,
        ],
        ["a platform notice", { ...delivery, createdBy: "system" }, true],
        ["a seat-finished report", { createdBy: "system", creationSource: "server" }, true],
      ] satisfies ReadonlyArray<readonly [string, Marker, boolean]>
    ).map(([source, marker, settles]) => [store, source, testLayer, marker, settles] as const),
  ),
)("%s: %s after the merge", ([, , testLayer, marker, settles]) =>
  Effect.gen(function* () {
    const threadId = yield* spawnedThread("source");
    yield* receive(threadId, marker, afterMerge);
    // A message that does not count leaves upstream's rule: the merge settles the thread.
    assert.deepEqual(yield* settlesAt(threadId, now), settles ? afterMerge : null);
  }).pipe(Effect.provide(testLayer)),
);
