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
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import {
  AgentCrewInstanceService,
  layer as crewInstanceLayer,
} from "./AgentCrewInstanceService.ts";
import {
  CrewRuntimeRequestService,
  layer as crewRuntimeRequestLayer,
  pendingCrewThreadRequests,
} from "./CrewRuntimeRequestService.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { SquadronId } from "./contracts.ts";

const squadronId = SquadronId.make("squadron:crew-requests");
const captainThread = ThreadId.make("thread:captain");
const builderThread = ThreadId.make("thread:builder");
const reservedThread = ThreadId.make("thread:reserved");
const strangerThread = ThreadId.make("thread:stranger");
const at = DateTime.makeUnsafe("2026-09-24T12:00:00.000Z");

type Request = OrchestrationV2ThreadProjection["runtimeRequests"][number];
const request = (
  id: string,
  kind: Request["kind"],
  status: Request["status"] = "pending",
  minute = 0,
): Request =>
  ({
    id: RuntimeRequestId.make(id),
    kind,
    status,
    responseCapability: { type: "live", providerSessionId: "session:1" },
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
        ],
        [
          {
            type: "approval_request",
            requestId: "req:builder-approval",
            prompt: "Run the test suite?",
          },
        ],
      ),
    ],
    [
      captainThread,
      projectionOf(
        captainThread,
        [request("req:captain-question", "user_input", "pending", 2)],
        [{ type: "user_input_request", requestId: "req:captain-question", questions: [question] }],
      ),
    ],
    [strangerThread, projectionOf(strangerThread, [request("req:stranger", "command")])],
  ]);
  const dispatched: Array<OrchestrationV2Command> = [];
  const racing = new Set<string>();
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
    getThreadProjection: (threadId) => {
      const projection = state.get(threadId);
      return projection === undefined
        ? Effect.die(new Error(`no thread ${threadId}`))
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
        if (pending?.status !== "pending" || racing.has(command.requestId))
          return yield* Effect.fail({
            message: "Failed to dispatch orchestration command runtime-request.respond.",
            cause: `Runtime request ${command.requestId} is resolved.`,
          } as never);
        dispatched.push(command);
        resolve(command.threadId, command.requestId);
        return { sequence: dispatched.length } as never;
      }),
  });
  return { layer, dispatched, resolve, racing };
};

const setup = Effect.gen(function* () {
  const storage = Layer.mergeAll(ledgerLayer, crewInstanceLayer).pipe(
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
  );
  const context = yield* Layer.build(storage);
  yield* runJ5A2AMigrations().pipe(Effect.provide(context));
  yield* Context.get(context, A2ALedger).createSquadron({
    squadron: { id: squadronId, name: "Requests", createdAt: DateTime.formatIso(at) },
  });
  yield* Context.get(context, AgentCrewInstanceService).record({
    id: "crew:requests",
    squadronId,
    captainParticipantId: participantIdForThread(captainThread),
    captainThreadId: captainThread,
    displayName: "Release Crew",
    brief: "Ship the release.",
    createdAt: DateTime.formatIso(at),
    members: [
      {
        seatName: "builder",
        agentId: null,
        participantId: participantIdForThread(builderThread),
        threadId: builderThread,
        reason: null,
      },
      // Reserved, never created: no thread to read.
      {
        seatName: "reserved",
        agentId: null,
        participantId: participantIdForThread(reservedThread),
        threadId: reservedThread,
        reason: null,
      },
    ],
  });
  return context;
});

const answer = (requestId: string, threadId: ThreadId, extra: object, n: number) => ({
  threadId,
  requestId: RuntimeRequestId.make(requestId),
  commandId: CommandId.make(`command:answer-${n}`),
  ...extra,
});

it("selects pending approvals and questions the way the composer does", () => {
  const pending = pendingCrewThreadRequests(
    projectionOf(
      builderThread,
      [
        request("a", "command"),
        request("b", "auth_refresh"),
        request("c", "dynamic_tool_call"),
        request("d", "user_input"), // no question item yet: not listed
        request("e", "file-change", "expired"),
      ],
      [],
    ),
  );
  assert.deepStrictEqual(
    pending.map((item) => [item.requestId, item.request.kind]),
    [["a", "approval"]],
  );
});

it.effect(
  "lists a live Crew's seat and Captain requests, answers each once, and drops a retired Crew",
  () =>
    Effect.gen(function* () {
      const context = yield* setup;
      const threads = makeThreads();
      const layer = crewRuntimeRequestLayer.pipe(
        Layer.provideMerge(threads.layer),
        Layer.provideMerge(Layer.succeedContext(context)),
      );
      yield* Effect.gen(function* () {
        const service = yield* CrewRuntimeRequestService;
        const listed = yield* service.list;
        // The stranger's thread sits in no Crew and is never listed.
        assert.deepStrictEqual(
          listed.map((item) => [item.requestId, item.seat, item.crewName, item.request.kind]),
          [
            ["req:builder-approval", "builder", "Release Crew", "approval"],
            ["req:captain-question", null, "Release Crew", "user_input"],
          ],
        );
        const approval = listed[0]!;
        if (approval.request.kind === "approval")
          assert.equal(approval.request.detail, "Run the test suite?");
        assert.equal(approval.threadTitle, `Thread ${builderThread}`);

        // One answer resolves the request; a second is refused and dispatches nothing.
        yield* service.respond(
          answer("req:builder-approval", builderThread, { decision: "accept" }, 1),
        );
        const second = yield* Effect.flip(
          service.respond(
            answer("req:builder-approval", builderThread, { decision: "decline" }, 2),
          ),
        );
        assert.equal(second._tag, "CrewRuntimeRequestConflictError");
        assert.lengthOf(threads.dispatched, 1);
        const sent = threads.dispatched[0]!;
        assert.equal(sent.type, "runtime-request.respond");
        if (sent.type === "runtime-request.respond") assert.equal(sent.decision, "accept");

        // Answered inline on another device first: refused, nothing sent.
        threads.resolve(captainThread, "req:captain-question");
        const late = yield* Effect.flip(
          service.respond(
            answer("req:captain-question", captainThread, { answers: { q1: "main" } }, 3),
          ),
        );
        assert.equal(late._tag, "CrewRuntimeRequestConflictError");
        assert.lengthOf(threads.dispatched, 1);
        assert.deepStrictEqual(yield* service.list, []);

        // A thread outside every live Crew is never answered here.
        const stranger = yield* Effect.flip(
          service.respond(answer("req:stranger", strangerThread, { decision: "accept" }, 4)),
        );
        assert.equal(stranger._tag, "CrewRuntimeRequestNotFoundError");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect("refuses an answer of the wrong kind and forgets a retired Crew's requests", () =>
  Effect.gen(function* () {
    const context = yield* setup;
    const threads = makeThreads();
    const layer = crewRuntimeRequestLayer.pipe(
      Layer.provideMerge(threads.layer),
      Layer.provideMerge(Layer.succeedContext(context)),
    );
    yield* Effect.gen(function* () {
      const service = yield* CrewRuntimeRequestService;
      // Lost a race at dispatch: refused with the orchestrator's own reason, nothing recorded.
      threads.racing.add("req:builder-approval");
      const raced = yield* Effect.flip(
        service.respond(answer("req:builder-approval", builderThread, { decision: "accept" }, 9)),
      );
      assert.equal(raced._tag, "CrewRuntimeRequestConflictError");
      assert.include(raced.message, "Runtime request req:builder-approval is resolved.");
      assert.lengthOf(threads.dispatched, 0);
      threads.racing.clear();

      const wrong = yield* Effect.flip(
        service.respond(answer("req:captain-question", captainThread, { decision: "accept" }, 1)),
      );
      assert.equal(wrong._tag, "CrewRuntimeRequestInvalidError");
      assert.lengthOf(threads.dispatched, 0);

      yield* Context.get(context, AgentCrewInstanceService).markArchived(
        "crew:requests",
        DateTime.formatIso(at),
      );
      assert.deepStrictEqual(yield* service.list, []);
      const retired = yield* Effect.flip(
        service.respond(answer("req:builder-approval", builderThread, { decision: "accept" }, 2)),
      );
      assert.equal(retired._tag, "CrewRuntimeRequestNotFoundError");
      assert.lengthOf(threads.dispatched, 0);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);
