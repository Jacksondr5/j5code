import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type { PlaybookDefinition, PlaybookError } from "@t3tools/contracts/j5";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import { stringify } from "yaml";

import {
  OrchestratorCommandRejectedError,
  OrchestratorDispatchError,
  OrchestratorProjectionError,
} from "../../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreThreadNotFoundError } from "../../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import {
  AgentCrewInstanceService,
  layer as crewInstanceLayer,
} from "../a2a/AgentCrewInstanceService.ts";
import { A2AArchiveFacts } from "../a2a/ArchiveFactsService.ts";
import { CrewStopService, layer as crewStopLayer } from "../a2a/CrewStopService.ts";
import { participantIdForThread } from "../a2a/HomeRegistrar.ts";
import { A2ALedger, layer as ledgerLayer } from "../a2a/LedgerService.ts";
import { runJ5A2AMigrations } from "../a2a/Migrations.ts";
import { SquadronId } from "../a2a/contracts.ts";
import { makePlaybookCrewRelay } from "./PlaybookCrewRelay.ts";
import { makePlaybookStore, PlaybookStore } from "./PlaybookStore.ts";
import { seedPlaybookOwners } from "./testFixtures.ts";

const squadronId = SquadronId.make("squadron:relay");
const captainThread = ThreadId.make("thread:relay:captain");
const otherCaptainThread = ThreadId.make("thread:relay:other-captain");
const seatAThread = ThreadId.make("thread:relay:a");
const seatBThread = ThreadId.make("thread:relay:b");
const createdAt = "2026-09-29T12:00:00.000Z";
const crewId = "crew:relay";

// inspect belongs to seat a, review to seat b, and nobody owns report.
const review: PlaybookDefinition = {
  title: "Review a change",
  description: "Inspect, review, and report.",
  steps: [
    { id: "inspect", title: "Inspect", prompt: "Read the change." },
    { id: "review", title: "Review", prompt: "Review the change." },
    { id: "report", title: "Report", prompt: "Report the findings." },
  ],
};

type SeatState = "live" | "archived";

const projection = (threadId: ThreadId, state: SeatState) =>
  ({
    thread: {
      id: threadId,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
      archivedAt: state === "archived" ? createdAt : null,
      deletedAt: null,
    },
    messages: [],
    runs: [],
  }) as unknown as OrchestrationV2ThreadProjection;

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "j5-playbook-relay-" });
  yield* fs.makeDirectory(path.join(root, ".j5/playbooks"), { recursive: true });
  const write = (name: string, value: PlaybookDefinition) =>
    fs.writeFileString(path.join(root, ".j5/playbooks", `${name}.yaml`), stringify(value));
  yield* write("review", review);
  yield* write("other", { ...review, title: "Another playbook" });
  yield* runJ5A2AMigrations();
  yield* seedPlaybookOwners([captainThread, otherCaptainThread]);

  const storage = yield* Layer.build(Layer.mergeAll(ledgerLayer, crewInstanceLayer));
  const crews = Context.get(storage, AgentCrewInstanceService);
  yield* Context.get(storage, A2ALedger).createSquadron({
    squadron: { id: squadronId, name: "Relay", createdAt },
  });
  const seat = (name: string, threadId: ThreadId, steps: ReadonlyArray<string>) => ({
    seatName: name,
    agentId: null,
    participantId: participantIdForThread(threadId),
    threadId,
    reason: null,
    playbookStepIds: steps,
  });
  const record = (id: string, playbook: string, captain = captainThread) =>
    crews.record({
      id,
      squadronId,
      captainParticipantId: participantIdForThread(captain),
      captainThreadId: captain,
      displayName: id,
      brief: "Follow the playbook.",
      createdAt,
      playbook: {
        name: playbook,
        definitionPath: path.resolve(root, ".j5/playbooks", `${playbook}.yaml`),
      },
      members: [seat("a", seatAThread, ["inspect"]), seat("b", seatBThread, ["review"])],
    });
  yield* record(crewId, "review");

  const seats = yield* Ref.make(
    new Map<ThreadId, SeatState>([
      [seatAThread, "live"],
      [seatBThread, "live"],
      [captainThread, "live"],
    ]),
  );
  const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2Command>>([]);
  // "transient" fails like a busy orchestrator; "reject" like a thread that refuses the notice.
  const dispatchFault = yield* Ref.make<"transient" | "reject" | null>(null);
  // A thread whose projection can't be read right now (not missing: the store can't answer).
  const projectionFault = yield* Ref.make<ThreadId | null>(null);
  const threads = ThreadManagementService.of({
    getThreadProjection: (threadId: ThreadId) =>
      Effect.all([Ref.get(seats), Ref.get(projectionFault)]).pipe(
        Effect.flatMap(([current, unreadable]) => {
          if (unreadable === threadId)
            return Effect.fail(new OrchestratorProjectionError({ threadId }));
          const state = current.get(threadId);
          return state === undefined
            ? Effect.fail(
                new OrchestratorProjectionError({
                  threadId,
                  cause: new ProjectionStoreThreadNotFoundError({ threadId }),
                }),
              )
            : Effect.succeed(projection(threadId, state));
        }),
      ),
    dispatch: (command: OrchestrationV2Command) =>
      Effect.gen(function* () {
        const fault = yield* Ref.get(dispatchFault);
        const commandId = "commandId" in command ? command.commandId : CommandId.make("none");
        if (fault === "transient")
          return yield* new OrchestratorDispatchError({ commandId, commandType: command.type });
        if (fault === "reject")
          return yield* new OrchestratorCommandRejectedError({
            commandId,
            commandType: command.type,
          });
        yield* Ref.update(dispatched, (items) => [...items, command]);
        return { sequence: 1, storedEvents: [] };
      }),
    // Every seat has a turn to interrupt, so a stop touches each of them.
    interruptThread: () => Effect.succeed({ type: "interrupt_requested" }),
  } as unknown as ThreadManagementService["Service"]);
  const store = yield* makePlaybookStore;
  const relay = yield* makePlaybookCrewRelay.pipe(
    Effect.provideService(PlaybookStore, store),
    Effect.provideService(AgentCrewInstanceService, crews),
    Effect.provideService(ThreadManagementService, threads),
  );
  const stopCrew = Effect.gen(function* () {
    const stops = yield* CrewStopService;
    return yield* stops.stop({
      callerParticipantId: participantIdForThread(captainThread),
      squadronId,
      crewInstanceId: crewId,
      commandIds: (seat) => ({ interruptCommandId: CommandId.make(`stop:${seat}`) }),
    });
  }).pipe(
    Effect.provide(
      crewStopLayer.pipe(
        Layer.provide(Layer.succeed(AgentCrewInstanceService, crews)),
        Layer.provide(Layer.succeed(ThreadManagementService, threads)),
        Layer.provide(Layer.mock(A2AArchiveFacts)({})),
      ),
    ),
  );
  const notices = Ref.get(dispatched).pipe(
    Effect.map((commands) =>
      commands.flatMap((command) =>
        command.type === "message.dispatch"
          ? [{ threadId: command.threadId, text: command.text }]
          : [],
      ),
    ),
  );
  const start = (key: string, crewInstanceId = crewId, name = "review", owner = captainThread) =>
    relay.start({ owner, root, name, key, crewInstanceId });
  const move = (
    runId: string,
    operation: "next" | "back" | "complete",
    expectedStepId: string,
    key: string,
  ) => relay.mutate(captainThread, { runId, operation, expectedStepId, client_request_id: key });
  return {
    root,
    write,
    store,
    crews,
    relay,
    seats,
    dispatchFault,
    notices,
    start,
    move,
    record,
    projectionFault,
    stopCrew,
  };
});

const TestLayer = Layer.mergeAll(
  NodeSqliteClient.layer({ filename: ":memory:" }),
  NodeServices.layer,
);
const failureCode = (error: PlaybookError) => error.code;

it.effect("starting a Crew-linked run hands the first step to the seat that owns it", () =>
  Effect.gen(function* () {
    const { start, notices, store } = yield* fixture;
    const started = yield* start("start-1");
    assert.deepStrictEqual(started.delivery, {
      state: "delivered",
      seat: "a",
      threadId: seatAThread,
    });
    assert.equal(started.crewInstanceId, crewId);
    const sent = yield* notices;
    assert.lengthOf(sent, 1);
    assert.equal(sent[0]?.threadId, seatAThread);
    assert.include(sent[0]?.text, "<j5_playbook_step>");
    assert.include(sent[0]?.text, "step: inspect | Inspect");
    assert.include(sent[0]?.text, "position: 1 of 3");
    assert.include(sent[0]?.text, "<step_prompt>\nRead the change.\n</step_prompt>");
    const landing = yield* store.landing(started.runId, "start-1");
    assert.equal(landing?.outcome, "delivered");
    assert.isNotNull(landing?.resolvedAt);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect(
  "refuses a Crew that isn't the caller's live Crew on that playbook, starting nothing",
  () =>
    Effect.gen(function* () {
      const { start, record, crews, notices, store } = yield* fixture;
      yield* record("crew:other-captain", "review", otherCaptainThread);
      yield* record("crew:other-playbook", "other");
      yield* record("crew:archived", "review");
      yield* crews.markArchived("crew:archived", createdAt);
      for (const crewInstanceId of [
        "crew:other-captain",
        "crew:other-playbook",
        "crew:archived",
        "crew:missing",
      ]) {
        const refusal = yield* start(`start:${crewInstanceId}`, crewInstanceId).pipe(Effect.flip);
        assert.equal(failureCode(refusal), "crew_not_linkable");
      }
      assert.lengthOf(yield* notices, 0);
      assert.lengthOf((yield* store.listForThread(captainThread)).runs, 0);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("advancing hands the new step's live prompt to exactly the seat that owns it", () =>
  Effect.gen(function* () {
    const { start, move, notices, write } = yield* fixture;
    const run = yield* start("start-1");
    // The prompt is read live at hand-off time.
    yield* write("review", {
      ...review,
      steps: review.steps.map((step) =>
        step.id === "review" ? { ...step, prompt: "Review the edited change." } : step,
      ),
    });
    const next = yield* move(run.runId, "next", "inspect", "next-1");
    assert.deepStrictEqual(next.delivery, { state: "delivered", seat: "b", threadId: seatBThread });
    const sent = yield* notices;
    assert.deepStrictEqual(
      sent.map(({ threadId }) => threadId),
      [seatAThread, seatBThread],
    );
    assert.include(sent[1]?.text, "Review the edited change.");
    assert.include(sent[1]?.text, "position: 2 of 3");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("an unowned step, a never-created seat, and an archived seat are the Captain's", () =>
  Effect.gen(function* () {
    const { start, move, notices, crews, seats, relay } = yield* fixture;
    const run = yield* start("start-1");
    yield* move(run.runId, "next", "inspect", "next-1");
    const unowned = yield* move(run.runId, "next", "review", "next-2");
    assert.deepStrictEqual(unowned.delivery, {
      state: "captain",
      seat: null,
      threadId: captainThread,
    });
    assert.lengthOf(yield* notices, 2);

    // Seat b's thread is archived: its step goes to the Captain, with no notice.
    yield* Ref.update(seats, (current) => new Map(current).set(seatBThread, "archived"));
    const archived = yield* move(run.runId, "back", "report", "back-1");
    assert.equal(archived.delivery?.state, "captain");
    assert.lengthOf(yield* notices, 2);

    // Seat a never came to exist, so its row was dropped: its step is unowned.
    yield* crews.removeMembers(crewId, ["a"]);
    const dropped = yield* move(run.runId, "back", "review", "back-2");
    assert.equal(dropped.delivery?.state, "captain");
    assert.lengthOf(yield* notices, 2);
    assert.equal((yield* relay.currentDelivery(run.runId, "inspect"))?.state, "captain");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("a retried playbook_next hands its step off once and replays the same delivery", () =>
  Effect.gen(function* () {
    const { start, move, notices, store } = yield* fixture;
    const run = yield* start("start-1");
    const first = yield* move(run.runId, "next", "inspect", "next-1");
    const retry = yield* move(run.runId, "next", "inspect", "next-1");
    assert.isTrue(retry.replayed);
    assert.deepStrictEqual(retry.delivery, first.delivery);
    assert.lengthOf(yield* notices, 2);
    assert.lengthOf(yield* store.pendingLandings(null), 0);
    assert.equal((yield* store.landing(run.runId, "next-1"))?.outcome, "delivered");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("the run doesn't move past a hand-off that hasn't finished", () =>
  Effect.gen(function* () {
    const { start, move, notices, dispatchFault, store } = yield* fixture;
    yield* Ref.set(dispatchFault, "transient");
    const run = yield* start("start-1");
    assert.deepStrictEqual(run.delivery, { state: "pending", seat: "a", threadId: seatAThread });
    const blocked = yield* move(run.runId, "next", "inspect", "next-1").pipe(Effect.flip);
    assert.equal(failureCode(blocked), "delivery_pending");
    assert.equal((yield* store.runById(run.runId))?.currentStepId, "inspect");

    // The same call, once the orchestrator recovers, hands off a's step first and then b's.
    yield* Ref.set(dispatchFault, null);
    const next = yield* move(run.runId, "next", "inspect", "next-1");
    assert.equal(next.delivery?.state, "delivered");
    assert.deepStrictEqual(
      (yield* notices).map(({ threadId }) => threadId),
      [seatAThread, seatBThread],
    );

    // Nothing retries on its own: after a restart, the Captain's next move finishes a pending
    // hand-off before it moves.
    yield* Ref.set(dispatchFault, "transient");
    yield* move(run.runId, "back", "review", "back-1");
    yield* Ref.set(dispatchFault, null);
    yield* move(run.runId, "next", "inspect", "next-2");
    assert.deepStrictEqual(
      (yield* notices).map(({ threadId }) => threadId),
      [seatAThread, seatBThread, seatAThread, seatBThread],
    );
    assert.lengthOf(yield* store.pendingLandings(null), 0);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("another thread's move is refused before any pending hand-off is sent", () =>
  Effect.gen(function* () {
    const { start, relay, dispatchFault, store, notices } = yield* fixture;
    yield* Ref.set(dispatchFault, "transient");
    const run = yield* start("start-1");
    yield* Ref.set(dispatchFault, null);
    const refused = yield* relay
      .mutate(otherCaptainThread, {
        runId: run.runId,
        operation: "next",
        expectedStepId: "inspect",
        client_request_id: "intruder-1",
      })
      .pipe(Effect.flip);
    assert.equal(failureCode(refused), "not_owner");
    assert.lengthOf(yield* notices, 0);
    assert.isNull((yield* store.landing(run.runId, "start-1"))?.resolvedAt);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("cancelling with a hand-off still pending cancels and skips it", () =>
  Effect.gen(function* () {
    const { start, relay, dispatchFault, store, notices } = yield* fixture;
    yield* Ref.set(dispatchFault, "transient");
    const run = yield* start("start-1");
    const cancelled = yield* relay.mutate(captainThread, {
      runId: run.runId,
      operation: "cancel",
      client_request_id: "cancel-1",
    });
    assert.equal(cancelled.status, "cancelled");
    assert.isNull(cancelled.delivery);
    assert.equal((yield* store.landing(run.runId, "start-1"))?.outcome, "skipped");
    yield* Ref.set(dispatchFault, null);
    assert.lengthOf(yield* store.pendingLandings(null), 0);
    assert.lengthOf(yield* notices, 0);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("a seat that refuses the notice leaves the step to the Captain", () =>
  Effect.gen(function* () {
    const { start, dispatchFault, store } = yield* fixture;
    yield* Ref.set(dispatchFault, "reject");
    const run = yield* start("start-1");
    assert.deepStrictEqual(run.delivery, {
      state: "captain",
      seat: null,
      threadId: captainThread,
    });
    // The seat stays on the row for the audit trail.
    const landing = yield* store.landing(run.runId, "start-1");
    assert.equal(landing?.targetSeat, "a");
    assert.equal(landing?.outcome, "captain");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("back and reselect hand the step to its owner again", () =>
  Effect.gen(function* () {
    const { start, move, relay, notices } = yield* fixture;
    const run = yield* start("start-1");
    yield* move(run.runId, "next", "inspect", "next-1");
    const back = yield* move(run.runId, "back", "review", "back-1");
    assert.equal(back.delivery?.seat, "a");
    const reselected = yield* relay.mutate(captainThread, {
      runId: run.runId,
      operation: "reselect",
      expectedStepId: "inspect",
      stepId: "review",
      client_request_id: "reselect-1",
    });
    assert.equal(reselected.delivery?.seat, "b");
    assert.deepStrictEqual(
      (yield* notices).map(({ threadId }) => threadId),
      [seatAThread, seatBThread, seatAThread, seatBThread],
    );
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("playbook_current reports who holds the step without handing it off again", () =>
  Effect.gen(function* () {
    const { start, move, relay, notices } = yield* fixture;
    const run = yield* start("start-1");
    yield* move(run.runId, "next", "inspect", "next-1");
    assert.deepStrictEqual((yield* relay.current(captainThread)).delivery, {
      state: "delivered",
      seat: "b",
      threadId: seatBThread,
    });
    yield* move(run.runId, "next", "review", "next-2");
    assert.deepStrictEqual((yield* relay.current(captainThread)).delivery, {
      state: "captain",
      seat: null,
      threadId: captainThread,
    });
    assert.lengthOf(yield* notices, 2);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("a hand-off that hasn't finished reads as pending, never as the Captain's", () =>
  Effect.gen(function* () {
    const { start, move, relay, notices, dispatchFault, projectionFault } = yield* fixture;
    const run = yield* start("start-1");
    // The target is resolved and persisted, but its dispatch keeps failing.
    yield* Ref.set(dispatchFault, "transient");
    const next = yield* move(run.runId, "next", "inspect", "next-1");
    assert.deepStrictEqual(next.delivery, { state: "pending", seat: "b", threadId: seatBThread });
    assert.deepStrictEqual((yield* relay.current(captainThread)).delivery, next.delivery);
    assert.lengthOf(yield* notices, 1);

    // Retrying the same call once the orchestrator recovers delivers it.
    yield* Ref.set(dispatchFault, null);
    const retried = yield* move(run.runId, "next", "inspect", "next-1");
    assert.equal(retried.delivery?.state, "delivered");
    // No target yet: the owner's thread can't be read, so nothing is persisted.
    yield* Ref.set(projectionFault, seatAThread);
    const back = yield* move(run.runId, "back", "review", "back-1");
    const unresolved = { state: "pending", seat: null, threadId: null } as const;
    assert.deepStrictEqual(back.delivery, unresolved);
    assert.deepStrictEqual((yield* relay.current(captainThread)).delivery, unresolved);
    assert.deepStrictEqual(yield* relay.fleetRun(crewId), {
      runId: run.runId,
      position: 1,
      total: 3,
      stepId: "inspect",
      stepTitle: "Inspect",
      state: "pending",
      seat: null,
    });
    assert.lengthOf(yield* notices, 2);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("Fleet reads the Crew's step and who holds it, and nothing once the run completes", () =>
  Effect.gen(function* () {
    const { start, move, relay } = yield* fixture;
    assert.isNull(yield* relay.fleetRun(crewId));
    const run = yield* start("start-1");
    yield* move(run.runId, "next", "inspect", "next-1");
    assert.deepStrictEqual(yield* relay.fleetRun(crewId), {
      runId: run.runId,
      position: 2,
      total: 3,
      stepId: "review",
      stepTitle: "Review",
      state: "delivered",
      seat: "b",
    });
    yield* move(run.runId, "next", "review", "next-2");
    const completed = yield* move(run.runId, "complete", "report", "complete-1");
    assert.isNull(completed.delivery);
    assert.isNull(yield* relay.fleetRun(crewId));
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("a retry after later moves reports who holds the step it shows, and sends nothing", () =>
  Effect.gen(function* () {
    const { start, move, notices } = yield* fixture;
    const run = yield* start("start-1");
    yield* move(run.runId, "next", "inspect", "next-1");
    // The retried start returns live progress at review, so its delivery is review's.
    const retriedStart = yield* start("start-1");
    assert.isTrue(retriedStart.replayed);
    assert.equal(retriedStart.currentStepId, "review");
    assert.deepStrictEqual(retriedStart.delivery, {
      state: "delivered",
      seat: "b",
      threadId: seatBThread,
    });
    yield* move(run.runId, "back", "review", "back-1");
    const retriedNext = yield* move(run.runId, "next", "inspect", "next-1");
    assert.equal(retriedNext.currentStepId, "inspect");
    assert.equal(retriedNext.delivery?.seat, "a");
    assert.lengthOf(yield* notices, 3);
    // Once the run has ended, a retry reports no delivery.
    yield* move(run.runId, "next", "inspect", "next-2");
    yield* move(run.runId, "next", "review", "next-3");
    yield* move(run.runId, "complete", "report", "complete-1");
    const afterEnd = yield* start("start-1");
    assert.equal(afterEnd.status, "completed");
    assert.isNull(afterEnd.delivery);
    assert.lengthOf(yield* notices, 4);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("an unreadable playbook keeps a hand-off pending until the YAML is repaired", () =>
  Effect.gen(function* () {
    const { start, move, store, write, root, notices, dispatchFault } = yield* fixture;
    yield* Ref.set(dispatchFault, "transient");
    const run = yield* start("start-1");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(path.join(root, ".j5/playbooks/review.yaml"), "title: [unclosed");
    yield* Ref.set(dispatchFault, null);
    const blocked = yield* move(run.runId, "next", "inspect", "next-1").pipe(Effect.flip);
    assert.equal(failureCode(blocked), "delivery_pending");
    assert.include(blocked.message, "can't be read");
    assert.isNull((yield* store.landing(run.runId, "start-1"))?.resolvedAt);
    assert.equal((yield* store.runById(run.runId))?.currentStepId, "inspect");
    assert.lengthOf(yield* notices, 0);

    // Repaired: a's step goes out first, then the move hands b its step.
    yield* write("review", review);
    const next = yield* move(run.runId, "next", "inspect", "next-1");
    assert.equal(next.delivery?.seat, "b");
    assert.deepStrictEqual(
      (yield* notices).map(({ threadId }) => threadId),
      [seatAThread, seatBThread],
    );
    assert.equal((yield* store.landing(run.runId, "start-1"))?.outcome, "delivered");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("a live definition without the landed step skips that hand-off", () =>
  Effect.gen(function* () {
    const { start, move, write, store, dispatchFault, notices } = yield* fixture;
    yield* Ref.set(dispatchFault, "transient");
    const run = yield* start("start-1");
    yield* Ref.set(dispatchFault, null);
    yield* write("review", { ...review, steps: review.steps.filter(({ id }) => id !== "inspect") });
    // The step is gone, so its landing is skipped; the move itself reports step_missing.
    const moved = yield* move(run.runId, "next", "inspect", "next-1").pipe(Effect.flip);
    assert.equal(failureCode(moved), "step_missing");
    assert.equal((yield* store.landing(run.runId, "start-1"))?.outcome, "skipped");
    assert.lengthOf(yield* notices, 0);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("stopping the Crew interrupts its seats and leaves its run where it is", () =>
  Effect.gen(function* () {
    const { start, move, stopCrew, store, notices } = yield* fixture;
    const run = yield* start("start-1");
    const before = yield* store.landing(run.runId, "start-1");
    const stopped = yield* stopCrew;
    assert.deepStrictEqual(
      stopped.members.map(({ seatName, result }) => [seatName, result]),
      [
        ["a", "interrupt_requested"],
        ["b", "interrupt_requested"],
      ],
    );
    const after = yield* store.runById(run.runId);
    assert.equal(after?.status, "active");
    assert.equal(after?.currentStepId, "inspect");
    assert.deepStrictEqual(yield* store.landing(run.runId, "start-1"), before);
    assert.lengthOf(yield* notices, 1);
    // The Captain carries on after a stop; the next step still reaches its seat.
    const next = yield* move(run.runId, "next", "inspect", "next-1");
    assert.equal(next.delivery?.state, "delivered");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("archiving the Crew cancels its run for good", () =>
  Effect.gen(function* () {
    const { start, move, store, dispatchFault } = yield* fixture;
    yield* Ref.set(dispatchFault, "transient");
    const run = yield* start("start-1");
    assert.deepStrictEqual(yield* store.cancelForCrew(crewId), [run.runId]);
    // Idempotent, so the archive's retry path can call it again.
    assert.deepStrictEqual(yield* store.cancelForCrew(crewId), []);
    assert.equal((yield* store.runById(run.runId))?.status, "cancelled");
    assert.equal((yield* store.landing(run.runId, "start-1"))?.outcome, "skipped");
    const after = yield* move(run.runId, "next", "inspect", "next-1").pipe(Effect.flip);
    assert.equal(failureCode(after), "run_terminal");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);
