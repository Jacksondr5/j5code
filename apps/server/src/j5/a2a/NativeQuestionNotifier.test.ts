import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as Crews from "./AgentCrewInstanceService.ts";
import * as Homes from "./HomeRegistrar.ts";
import * as Ledger from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import * as Notifier from "./NativeQuestionNotifier.ts";
import * as Placements from "./PlacementService.ts";
import { CommCommandId, LedgerProjectId } from "./contracts.ts";
import { PlacementCommandId } from "./placementContracts.ts";

const timestamp = "2026-10-19T12:00:00.000Z";
const now = DateTime.makeUnsafe(timestamp);
const projectId = LedgerProjectId.make("project:native-question");
const parentId = ThreadId.make("thread:question-spawner");
const childId = ThreadId.make("thread:placed-peer");

const run = (id: ThreadId, status: OrchestrationV2Run["status"]): OrchestrationV2Run => ({
  id: RunId.make(`run:${id}`),
  threadId: id,
  ordinal: 1,
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
  providerThreadId: null,
  userMessageId: MessageId.make(`message:${id}`),
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: now,
  startedAt: now,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
});

const projection = (id: ThreadId): OrchestrationV2ThreadProjection => ({
  thread: {
    id,
    projectId: ProjectId.make(projectId),
    title: id,
    createdBy: "agent",
    creationSource: "mcp",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    settledAt: null,
    settledOverride: null,
    lastVisitedAt: null,
  },
  runs: [],
  attempts: [],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  messages: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [],
  updatedAt: now,
});

const question = (
  capability: OrchestrationV2RuntimeRequest["responseCapability"]["type"] = "live",
): OrchestrationV2RuntimeRequest => ({
  id: RuntimeRequestId.make(`question:${capability}`),
  nodeId: NodeId.make("node:question"),
  providerTurnId: null,
  nativeRequestRef: null,
  kind: "user_input",
  status: "pending",
  responseCapability:
    capability === "live"
      ? { type: "live", providerSessionId: ProviderSessionId.make("session:question") }
      : capability === "message"
        ? { type: "message" }
        : { type: "not_resumable", reason: "Provider session ended" },
  createdAt: now,
  resolvedAt: null,
});

const storedRequest = (request: OrchestrationV2RuntimeRequest): OrchestrationV2StoredEvent => ({
  sequence: 1,
  commandId: null,
  event: {
    id: EventId.make(`event:${request.id}:${request.status}`),
    type: "runtime-request.updated",
    threadId: childId,
    occurredAt: now,
    payload: request,
  },
});

const setup = Effect.gen(function* () {
  const database = NodeSqliteClient.layer({ filename: ":memory:" });
  const storage = Layer.mergeAll(Ledger.layer, Placements.layer, Crews.layer).pipe(
    Layer.provideMerge(database),
    Layer.provideMerge(Homes.layer.pipe(Layer.provide(Ledger.layer), Layer.provide(database))),
  );
  const context = yield* Layer.build(storage);
  yield* runJ5A2AMigrations().pipe(Effect.provide(context));
  const homes = Context.get(context, Homes.A2AHomeRegistrar);
  const placements = Context.get(context, Placements.ParticipantPlacementService);
  for (const id of [parentId, childId]) {
    yield* homes.registerAtCreation({
      projectId,
      threadId: id,
      createdAt: timestamp,
      commandId: CommCommandId.make(`home:${id}`),
    });
    yield* placements.recordCreation({
      commandId: PlacementCommandId.make(`place:${id}`),
      projectId,
      participantId: Homes.participantIdForThread(id),
      actor: "platform",
      provenance:
        id === childId
          ? {
              kind: "spawned-by",
              spawnedByParticipantId: Homes.participantIdForThread(parentId),
              source: "j5_spawn",
            }
          : { kind: "unknown", source: "native_or_unobserved" },
      createdAt: timestamp,
    });
  }
  const state = new Map([
    [parentId, projection(parentId)],
    [childId, projection(childId)],
  ]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const reads: Array<{ threadId: ThreadId; records: ReadonlyArray<string> }> = [];
  const receipts = new Set<string>();
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadProjection: (id) =>
      Effect.sync(() => {
        reads.push({ threadId: id, records: ["full projection"] });
        return state.get(id)!;
      }),
    getThreadRecords: (id, records) =>
      Effect.sync(() => {
        reads.push({ threadId: id, records });
        return state.get(id)!;
      }),
    dispatch: (command) =>
      Effect.sync(() => {
        // The real orchestrator commits each command once; replay uses its retained receipt.
        if (!receipts.has(command.commandId)) {
          receipts.add(command.commandId);
          dispatched.push(command);
        }
        return { sequence: dispatched.length } as never;
      }),
  });
  const notifier = yield* Notifier.NativeQuestionNotifier.pipe(
    Effect.provide(Notifier.manualLayer.pipe(Layer.provide(threads))),
    Effect.provide(context),
  );
  const setRequest = (request: OrchestrationV2RuntimeRequest) => {
    state.set(childId, { ...state.get(childId)!, runtimeRequests: [request] });
  };
  return { notifier, state, dispatched, setRequest, context, reads };
});

it.effect("names the agent in its notice without loading parent run history", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const request = question();
    fixture.setRequest(request);
    const child = fixture.state.get(childId)!;
    fixture.state.set(childId, {
      ...child,
      thread: { ...child.thread, title: "Invoice migration reviewer" },
    });
    yield* fixture.notifier.handleStoredEvent(storedRequest(request));
    const notice = fixture.dispatched[0];
    assert.equal(notice?.type, "message.dispatch");
    if (notice?.type !== "message.dispatch") return;
    assert.include(notice.text, "Invoice migration reviewer");
    assert.isFalse(
      fixture.reads.some((read) => read.threadId === parentId && read.records.includes("runs")),
    );
  }),
);

it.effect("ignores an unplaced thread's question without reading thread projections", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const event = storedRequest(question());
    yield* fixture.notifier.handleStoredEvent({
      ...event,
      event: { ...event.event, threadId: parentId },
    });
    assert.deepEqual(fixture.dispatched, []);
    assert.deepEqual(fixture.reads, []);
  }),
);

it.effect.each(["live", "message"] as const)(
  "notifies a placed Peer parent once for a %s native question",
  (capability) =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      const request = question(capability);
      fixture.setRequest(request);
      yield* fixture.notifier.handleStoredEvent(storedRequest(request));
      yield* fixture.notifier.handleStoredEvent(storedRequest(request));
      assert.equal(fixture.dispatched.length, 1);
      const notice = fixture.dispatched[0]!;
      assert.equal(notice.type, "message.dispatch");
      if (notice.type !== "message.dispatch") return;
      assert.equal(notice.threadId, parentId);
      assert.deepEqual(notice.dispatchMode, { type: "queue_after_active" });
      assert.include(notice.text, childId);
      assert.include(notice.text, request.id);
      assert.include(notice.text, "t3_pending_request_read");
      assert.include(notice.text, "t3_pending_request_respond");
    }),
);

it.effect("cancels only the queued parent notice after a question resolves", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const request = question();
    fixture.setRequest(request);
    yield* fixture.notifier.handleStoredEvent(storedRequest(request));
    const notice = fixture.dispatched[0];
    assert.equal(notice?.type, "message.dispatch");
    if (notice?.type !== "message.dispatch") return;
    const queuedId = RunId.make("run:question-wake");
    fixture.state.set(parentId, {
      ...fixture.state.get(parentId)!,
      runs: [{ ...run(parentId, "queued"), id: queuedId, userMessageId: notice.messageId }],
    });
    const resolved = { ...request, status: "resolved" as const, resolvedAt: now };
    fixture.setRequest(resolved);
    yield* fixture.notifier.handleStoredEvent(storedRequest(resolved));
    const cancellation = fixture.dispatched.at(-1);
    assert.equal(cancellation?.type, "queued-run.cancel");
    if (cancellation?.type !== "queued-run.cancel") return;
    assert.equal(cancellation.threadId, parentId);
    assert.equal(cancellation.runId, queuedId);
  }),
);

it.effect.each(["waiting", "completed", "failed"] as const)(
  "catches up a native question on %s without duplicating its event notice",
  (status) =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      const request = question();
      fixture.setRequest(request);
      const event: OrchestrationV2StoredEvent = {
        sequence: 2,
        commandId: null,
        event: {
          id: EventId.make(`event:run:${status}`),
          type: "run.updated",
          threadId: childId,
          occurredAt: now,
          payload: run(childId, status),
        },
      };
      yield* fixture.notifier.handleStoredEvent(event);
      yield* fixture.notifier.handleStoredEvent(storedRequest(request));
      yield* fixture.notifier.handleStoredEvent(event);
      assert.equal(fixture.dispatched.length, 1);
      assert.equal(fixture.dispatched[0]?.type, "message.dispatch");
    }),
);

it.effect("notifies about an unresumable pending question without promising an answer", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const request = question("not_resumable");
    fixture.setRequest(request);
    yield* fixture.notifier.handleStoredEvent(storedRequest(request));
    const notice = fixture.dispatched[0];
    assert.equal(notice?.type, "message.dispatch");
    if (notice?.type !== "message.dispatch") return;
    assert.include(notice.text, childId);
    assert.notInclude(notice.text, "t3_pending_request_respond");
  }),
);

it.effect.each(["live", "retired"] as const)(
  "notifies the Captain only for a live Crew seat: %s Crew",
  (lifecycle) =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      const crews = Context.get(fixture.context, Crews.AgentCrewInstanceService);
      yield* crews.record({
        id: "crew:question",
        projectId,
        captainParticipantId: Homes.participantIdForThread(parentId),
        captainThreadId: parentId,
        displayName: "Question Crew",
        brief: "Do the task",
        createdAt: timestamp,
        members: [
          {
            seatName: "builder",
            agentId: null,
            participantId: Homes.participantIdForThread(childId),
            threadId: childId,
            reason: null,
          },
        ],
      });
      if (lifecycle === "retired") yield* crews.markArchived("crew:question", timestamp);
      const request = question();
      fixture.setRequest(request);
      yield* fixture.notifier.handleStoredEvent(storedRequest(request));
      assert.equal(fixture.dispatched.length, lifecycle === "live" ? 1 : 0);
    }),
);

it.effect.each([
  "archived-child",
  "deleted-child",
  "archived-parent",
  "deleted-parent",
  "delegated-child",
  "root",
  "approval",
] as const)("does not create a parent question notice for %s", (excluded) =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const request = {
      ...question(),
      ...(excluded === "approval" ? { kind: "command" as const } : {}),
    };
    fixture.setRequest(request);
    if (excluded.startsWith("archived") || excluded.startsWith("deleted")) {
      const id = excluded.endsWith("parent") ? parentId : childId;
      const value = fixture.state.get(id)!;
      fixture.state.set(id, {
        ...value,
        thread: {
          ...value.thread,
          ...(excluded.startsWith("archived") ? { archivedAt: now } : { deletedAt: now }),
        },
      });
    }
    if (excluded === "delegated-child") {
      const value = fixture.state.get(childId)!;
      fixture.state.set(childId, {
        ...value,
        thread: {
          ...value.thread,
          lineage: {
            parentThreadId: parentId,
            relationshipToParent: "subagent",
            rootThreadId: parentId,
          },
        },
      });
    }
    let event = storedRequest(request);
    if (excluded === "root") {
      fixture.state.set(parentId, {
        ...fixture.state.get(parentId)!,
        runtimeRequests: [request],
      });
      event = { ...event, event: { ...event.event, threadId: parentId } };
    }
    yield* fixture.notifier.handleStoredEvent(event);
    assert.deepEqual(fixture.dispatched, []);
  }),
);

it.effect.each(["cancelled", "expired"] as const)(
  "removes a queued notice when its question is %s",
  (status) =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      const request = question();
      fixture.setRequest(request);
      yield* fixture.notifier.handleStoredEvent(storedRequest(request));
      const notice = fixture.dispatched[0];
      assert.equal(notice?.type, "message.dispatch");
      if (notice?.type !== "message.dispatch") return;
      const queued = { ...run(parentId, "queued"), userMessageId: notice.messageId };
      fixture.state.set(parentId, { ...fixture.state.get(parentId)!, runs: [queued] });
      const ended = { ...request, status, resolvedAt: now };
      fixture.setRequest(ended);
      yield* fixture.notifier.handleStoredEvent(storedRequest(ended));
      const cancellation = fixture.dispatched.at(-1);
      assert.equal(cancellation?.type, "queued-run.cancel");
      if (cancellation?.type === "queued-run.cancel") assert.equal(cancellation.runId, queued.id);
    }),
);

it.effect("leaves a delivered notice historical when its question resolves", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const request = question();
    fixture.setRequest(request);
    yield* fixture.notifier.handleStoredEvent(storedRequest(request));
    const notice = fixture.dispatched[0];
    assert.equal(notice?.type, "message.dispatch");
    if (notice?.type !== "message.dispatch") return;
    fixture.state.set(parentId, {
      ...fixture.state.get(parentId)!,
      runs: [{ ...run(parentId, "running"), userMessageId: notice.messageId }],
    });
    const resolved = { ...request, status: "resolved" as const, resolvedAt: now };
    fixture.setRequest(resolved);
    yield* fixture.notifier.handleStoredEvent(storedRequest(resolved));
    assert.equal(fixture.dispatched.length, 1);
  }),
);

it.effect("does not invent a recipient after the placement parent leaves the ledger", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    yield* Context.get(fixture.context, Ledger.A2ALedger).append({
      projectId,
      commandId: CommCommandId.make("parent:left"),
      acceptedAt: timestamp,
      event: {
        kind: "participant.left",
        sender: null,
        receiver: null,
        exchangeId: null,
        correlationId: null,
        createdAt: timestamp,
        payload: {
          participant: {
            kind: "agent",
            id: Homes.participantIdForThread(parentId),
            threadId: parentId,
          },
        },
      },
    });
    const request = question();
    fixture.setRequest(request);
    yield* fixture.notifier.handleStoredEvent(storedRequest(request));
    assert.deepEqual(fixture.dispatched, []);
  }),
);

it.effect(
  "keeps a cross-project spawn at the root instead of notifying its provenance spawner",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      const elsewhere = LedgerProjectId.make("project:question-elsewhere");
      const crossProjectId = ThreadId.make("thread:cross-project-peer");
      yield* Context.get(fixture.context, Homes.A2AHomeRegistrar).registerAtCreation({
        projectId: elsewhere,
        threadId: crossProjectId,
        createdAt: timestamp,
        commandId: CommCommandId.make("home:cross-project"),
      });
      const recorded = yield* Context.get(
        fixture.context,
        Placements.ParticipantPlacementService,
      ).recordCreation({
        projectId: elsewhere,
        participantId: Homes.participantIdForThread(crossProjectId),
        commandId: PlacementCommandId.make("place:cross-project"),
        actor: "platform",
        createdAt: timestamp,
        provenance: {
          kind: "spawned-by",
          spawnedByParticipantId: Homes.participantIdForThread(parentId),
          source: "j5_spawn",
        },
      });
      assert.isNull(recorded.placement.placementParentId);
      const request = question();
      fixture.state.set(crossProjectId, {
        ...projection(crossProjectId),
        runtimeRequests: [request],
      });
      const event = storedRequest(request);
      yield* fixture.notifier.handleStoredEvent({
        ...event,
        event: { ...event.event, threadId: crossProjectId },
      });
      assert.deepEqual(fixture.dispatched, []);
    }),
);

it.effect("does not revive a question already resolved before its pending event is handled", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const request = question();
    fixture.setRequest({ ...request, status: "resolved", resolvedAt: now });
    yield* fixture.notifier.handleStoredEvent(storedRequest(request));
    assert.deepEqual(fixture.dispatched, []);
  }),
);
