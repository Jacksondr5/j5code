import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  OrchestratorDispatchError,
  OrchestratorProjectionError,
} from "../../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreThreadNotFoundError } from "../../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import {
  AgentCrewInstanceService,
  layer as crewInstanceLayer,
} from "./AgentCrewInstanceService.ts";
import {
  CrewRuntimeRequestService,
  inboxAnswerableApprovals,
  layer as crewRuntimeRequestLayer,
} from "./CrewRuntimeRequestService.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { SquadronId } from "./contracts.ts";

const squadronId = SquadronId.make("squadron:crew-requests");
const captainThread = ThreadId.make("thread:captain");
const secondCaptainThread = ThreadId.make("thread:captain-two");
const builderThread = ThreadId.make("thread:builder");
const reservedThread = ThreadId.make("thread:reserved");
const strangerThread = ThreadId.make("thread:stranger");
const at = DateTime.makeUnsafe("2026-09-24T12:00:00.000Z");

type Request = OrchestrationV2ThreadProjection["runtimeRequests"][number];
type Capability = "live" | "message" | "not_resumable";
const request = (
  id: string,
  kind: Request["kind"],
  status: Request["status"] = "pending",
  minute = 0,
  capability: Capability = "live",
): Request =>
  ({
    id: RuntimeRequestId.make(id),
    kind,
    status,
    responseCapability:
      capability === "live"
        ? { type: "live", providerSessionId: "session:1" }
        : capability === "message"
          ? { type: "message" }
          : { type: "not_resumable", reason: "session ended" },
    createdAt: DateTime.add(at, { minutes: minute }),
    resolvedAt: null,
  }) as unknown as Request;

const projectionOf = (
  threadId: ThreadId,
  runtimeRequests: ReadonlyArray<Request>,
  turnItems: ReadonlyArray<unknown> = [],
): OrchestrationV2ThreadProjection =>
  ({
    thread: {
      id: threadId,
      projectId: ProjectId.make("project:crew-requests"),
      title: `Thread ${threadId}`,
      archivedAt: null,
    },
    runtimeRequests,
    turnItems,
  }) as unknown as OrchestrationV2ThreadProjection;

const question = {
  id: "q1",
  header: "Branch",
  question: "Which branch should I use?",
  options: [{ label: "main", description: "The default branch" }],
};

/** Mutable thread state; dispatch resolves a pending request once, as the orchestrator does. */
const makeThreads = () => {
  const state = new Map<ThreadId, OrchestrationV2ThreadProjection>([
    [
      builderThread,
      projectionOf(
        builderThread,
        [
          request("req:builder-approval", "command", "pending", 1),
          request("req:builder-auth", "auth_refresh"),
          request("req:builder-tool", "dynamic_tool_call"),
          request("req:builder-done", "command", "resolved"),
          // Not answerable from the Inbox, so they stay in the seat's thread.
          request("req:builder-message", "command", "pending", 3, "message"),
          request("req:builder-gone", "file-change", "pending", 4, "not_resumable"),
          request("req:builder-question", "user_input", "pending", 5),
        ],
        [
          {
            type: "approval_request",
            requestId: "req:builder-approval",
            prompt: "Run the test suite?",
          },
          { type: "user_input_request", requestId: "req:builder-question", questions: [question] },
        ],
      ),
    ],
    [
      captainThread,
      projectionOf(
        captainThread,
        [
          request("req:captain-approval", "command", "pending", 0),
          request("req:captain-question", "user_input", "pending", 2),
        ],
        [{ type: "user_input_request", requestId: "req:captain-question", questions: [question] }],
      ),
    ],
    [strangerThread, projectionOf(strangerThread, [request("req:stranger", "command")])],
  ]);
  const dispatched: Array<OrchestrationV2Command> = [];
  const racing = new Set<string>();
  /** Threads whose store read fails for a reason other than the thread being absent. */
  const broken = new Set<ThreadId>();
  /** Requests whose dispatch fails for a reason other than the decider's refusal. */
  const failing = new Set<string>();
  const resolve = (threadId: ThreadId, requestId: string) => {
    const projection = state.get(threadId)!;
    state.set(threadId, {
      ...projection,
      runtimeRequests: projection.runtimeRequests.map((entry) =>
        entry.id === requestId ? { ...entry, status: "resolved" as const } : entry,
      ),
    });
  };
  const layer = Layer.mock(ThreadManagementService)({
    // Fails the way the real service does: a typed projection error whose cause says why.
    getThreadProjection: (threadId) => {
      const projection = state.get(threadId);
      if (broken.has(threadId))
        return Effect.fail(
          new OrchestratorProjectionError({ threadId, cause: new Error("database is locked") }),
        );
      return projection === undefined
        ? Effect.fail(
            new OrchestratorProjectionError({
              threadId,
              cause: new ProjectionStoreThreadNotFoundError({ threadId }),
            }),
          )
        : Effect.succeed(projection);
    },
    dispatch: (command) =>
      Effect.gen(function* () {
        if (command.type !== "runtime-request.respond") return yield* Effect.die("unexpected");
        const pending = state
          .get(command.threadId)
          ?.runtimeRequests.find((entry) => entry.id === command.requestId);
        // Resolved on another device after the service read it: the orchestrator refuses.
        if (racing.has(command.requestId)) resolve(command.threadId, command.requestId);
        if (failing.has(command.requestId))
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: new Error("event store write failed"),
          });
        // The decider's refusal carries its reason as a string.
        if (pending?.status !== "pending" || racing.has(command.requestId))
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Runtime request ${command.requestId} is resolved.`,
          });
        dispatched.push(command);
        resolve(command.threadId, command.requestId);
        return { sequence: dispatched.length } as never;
      }),
  });
  return { layer, dispatched, resolve, racing, broken, failing };
};

const seatOf = (seatName: string, threadId: ThreadId) => ({
  seatName,
  agentId: null,
  participantId: participantIdForThread(threadId),
  threadId,
  reason: null,
});

const setup = Effect.gen(function* () {
  const storage = Layer.mergeAll(ledgerLayer, crewInstanceLayer).pipe(
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  );
  const context = yield* Layer.build(storage);
  yield* runJ5A2AMigrations().pipe(Effect.provide(context));
  yield* Context.get(context, A2ALedger).ensureProject({
    projectId: squadronId,
    createdAt: DateTime.formatIso(at),
  });
  const instances = Context.get(context, AgentCrewInstanceService);
  yield* instances.record({
    id: "crew:requests",
    squadronId,
    captainParticipantId: participantIdForThread(captainThread),
    captainThreadId: captainThread,
    displayName: "Release Crew",
    brief: "Ship the release.",
    createdAt: DateTime.formatIso(at),
    // Reserved, never created: no thread to read.
    members: [seatOf("builder", builderThread), seatOf("reserved", reservedThread)],
  });
  // A second live Crew record naming the same seat thread: its approvals are still listed once.
  yield* instances.record({
    id: "crew:requests-again",
    squadronId,
    captainParticipantId: participantIdForThread(secondCaptainThread),
    captainThreadId: secondCaptainThread,
    displayName: "Follow-up Crew",
    brief: "Tidy up after the release.",
    createdAt: DateTime.formatIso(DateTime.add(at, { minutes: 1 })),
    members: [seatOf("builder-again", builderThread)],
  });
  return context;
});

const answer = (
  requestId: string,
  threadId: ThreadId,
  decision: "accept" | "decline",
  n: number,
) => ({
  threadId,
  requestId: RuntimeRequestId.make(requestId),
  commandId: CommandId.make(`command:answer-${n}`),
  decision,
});

const provideService = <R>(context: Context.Context<R>, threads: ReturnType<typeof makeThreads>) =>
  crewRuntimeRequestLayer.pipe(
    Layer.provideMerge(threads.layer),
    Layer.provideMerge(Layer.succeedContext(context)),
  );

it("selects only the pending approvals the provider can still take", () => {
  const pending = inboxAnswerableApprovals(
    projectionOf(
      builderThread,
      [
        request("a", "command"),
        request("b", "auth_refresh"),
        request("c", "dynamic_tool_call"),
        request("d", "user_input"),
        request("e", "file-change", "expired"),
        request("f", "file-read", "pending", 0, "message"),
        request("g", "file-read", "pending", 0, "not_resumable"),
      ],
      [{ type: "user_input_request", requestId: "d", questions: [question] }],
    ),
  );
  assert.deepStrictEqual(
    pending.map((item) => [item.requestId, item.requestKind]),
    [["a", "command"]],
  );
});

it.effect(
  "lists a seat's approval once and leaves the Captain, questions, and the rest inline",
  () =>
    Effect.gen(function* () {
      const context = yield* setup;
      const threads = makeThreads();
      yield* Effect.gen(function* () {
        const service = yield* CrewRuntimeRequestService;
        const listed = yield* service.list;
        // The Captain's thread, the seat's question, its non-live approvals, and the stranger's
        // thread are never listed; the seat named by two Crew records appears once, under the first.
        assert.deepStrictEqual(
          listed.map((item) => [item.requestId, item.seat, item.crewName]),
          [["req:builder-approval", "builder", "Release Crew"]],
        );
        assert.equal(listed[0]!.detail, "Run the test suite?");
        assert.equal(listed[0]!.threadTitle, `Thread ${builderThread}`);

        // One answer resolves the request; a second is refused and dispatches nothing.
        yield* service.respond(answer("req:builder-approval", builderThread, "accept", 1));
        const second = yield* Effect.flip(
          service.respond(answer("req:builder-approval", builderThread, "decline", 2)),
        );
        assert.equal(second._tag, "CrewRuntimeRequestConflictError");
        assert.lengthOf(threads.dispatched, 1);
        const sent = threads.dispatched[0]!;
        assert.equal(sent.type, "runtime-request.respond");
        if (sent.type === "runtime-request.respond") assert.equal(sent.decision, "accept");
        assert.deepStrictEqual(yield* service.list, []);

        // Answered in its own thread: never answered here, whatever the request.
        for (const requestId of ["req:captain-approval", "req:captain-question"]) {
          const captain = yield* Effect.flip(
            service.respond(answer(requestId, captainThread, "accept", 3)),
          );
          assert.equal(captain._tag, "CrewRuntimeRequestNotFoundError");
        }
        // A thread outside every live Crew is never answered here.
        const stranger = yield* Effect.flip(
          service.respond(answer("req:stranger", strangerThread, "accept", 4)),
        );
        assert.equal(stranger._tag, "CrewRuntimeRequestNotFoundError");
        assert.lengthOf(threads.dispatched, 1);
      }).pipe(Effect.provide(provideService(context, threads)));
    }).pipe(Effect.scoped),
);

it.effect("answers only what it lists, and forgets a retired Crew's seats", () =>
  Effect.gen(function* () {
    const context = yield* setup;
    const threads = makeThreads();
    yield* Effect.gen(function* () {
      const service = yield* CrewRuntimeRequestService;
      // Unlisted on a seat's thread: hidden kinds, the question, and approvals no longer live.
      for (const hidden of [
        "req:builder-auth",
        "req:builder-tool",
        "req:builder-question",
        "req:builder-message",
        "req:builder-gone",
      ]) {
        const refused = yield* Effect.flip(
          service.respond(answer(hidden, builderThread, "accept", 1)),
        );
        assert.equal(refused._tag, "CrewRuntimeRequestNotFoundError");
      }
      assert.lengthOf(threads.dispatched, 0);

      // Lost a race at dispatch: refused with the orchestrator's own reason, nothing recorded.
      threads.racing.add("req:builder-approval");
      const raced = yield* Effect.flip(
        service.respond(answer("req:builder-approval", builderThread, "accept", 2)),
      );
      assert.equal(raced._tag, "CrewRuntimeRequestConflictError");
      assert.include(raced.message, "Runtime request req:builder-approval is resolved.");
      assert.lengthOf(threads.dispatched, 0);
      threads.racing.clear();

      // Retiring both Crews that name the seat takes its approvals out of the Inbox.
      const instances = Context.get(context, AgentCrewInstanceService);
      yield* instances.markArchived("crew:requests", DateTime.formatIso(at));
      yield* instances.markArchived("crew:requests-again", DateTime.formatIso(at));
      assert.deepStrictEqual(yield* service.list, []);
      const retired = yield* Effect.flip(
        service.respond(answer("req:builder-approval", builderThread, "accept", 3)),
      );
      assert.equal(retired._tag, "CrewRuntimeRequestNotFoundError");
      assert.lengthOf(threads.dispatched, 0);
    }).pipe(Effect.provide(provideService(context, threads)));
  }).pipe(Effect.scoped),
);

it.effect("reports a store or dispatch failure as one", () =>
  Effect.gen(function* () {
    const context = yield* setup;
    const threads = makeThreads();
    yield* Effect.gen(function* () {
      const service = yield* CrewRuntimeRequestService;
      // A dispatch that failed for any reason but the decider's refusal is a failure, not a 409.
      threads.failing.add("req:builder-approval");
      const failed = yield* Effect.flip(
        service.respond(answer("req:builder-approval", builderThread, "accept", 1)),
      );
      assert.equal(failed._tag, "CrewRuntimeRequestDispatchError");
      threads.failing.clear();

      // A thread the store cannot read is an error, never an empty Inbox or a missing request.
      threads.broken.add(builderThread);
      const listFailure = yield* Effect.flip(service.list);
      assert.equal(listFailure._tag, "OrchestratorProjectionError");
      const answerFailure = yield* Effect.flip(
        service.respond(answer("req:builder-approval", builderThread, "accept", 2)),
      );
      assert.equal(answerFailure._tag, "OrchestratorProjectionError");
      assert.lengthOf(threads.dispatched, 0);
    }).pipe(Effect.provide(provideService(context, threads)));
  }).pipe(Effect.scoped),
);
