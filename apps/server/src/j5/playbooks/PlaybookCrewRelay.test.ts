import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
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
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import { stringify } from "yaml";

import {
  OrchestratorDispatchError,
  OrchestratorProjectionError,
} from "../../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreThreadNotFoundError } from "../../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import {
  AgentCrewInstanceService,
  layer as crewInstanceLayer,
} from "../a2a/AgentCrewInstanceService.ts";
import { participantIdForThread } from "../a2a/HomeRegistrar.ts";
import { A2ALedger, layer as ledgerLayer } from "../a2a/LedgerService.ts";
import { runJ5A2AMigrations } from "../a2a/Migrations.ts";
import { LedgerProjectId } from "../a2a/contracts.ts";
import { makePlaybookCrewRelay } from "./PlaybookCrewRelay.ts";
import { makePlaybookStore, PlaybookStore } from "./PlaybookStore.ts";
import { seedPlaybookOwners } from "./testFixtures.ts";

const projectId = LedgerProjectId.make("project:runtime-holders");
const owner = ThreadId.make("thread:playbook:owner");
const peer = ThreadId.make("thread:playbook:peer");
const crewMember = ThreadId.make("thread:playbook:crew-member");
const foreign = ThreadId.make("thread:playbook:foreign");
const ownerId = participantIdForThread(owner);
const peerId = participantIdForThread(peer);
const crewId = participantIdForThread(crewMember);
const foreignId = participantIdForThread(foreign);
const at = "2026-11-17T12:00:00.000Z";
const definition: PlaybookDefinition = {
  title: "Review a change",
  description: "Inspect, review, report.",
  steps: [
    { id: "inspect", title: "Inspect", prompt: "Read the change." },
    { id: "review", title: "Review", prompt: "Review the change." },
    { id: "report", title: "Report", prompt: "Report the result." },
  ],
};
const projection = (id: ThreadId, archived: boolean): OrchestrationV2ThreadProjection =>
  ({
    thread: {
      id,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-sol" },
      archivedAt: archived ? at : null,
      deletedAt: null,
    },
    messages: [],
    runs: [],
  }) as unknown as OrchestrationV2ThreadProjection;

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "j5-runtime-holder-" });
  yield* fs.makeDirectory(path.join(root, ".j5/playbooks"), { recursive: true });
  yield* fs.writeFileString(path.join(root, ".j5/playbooks/review.yaml"), stringify(definition));
  yield* runJ5A2AMigrations();
  yield* seedPlaybookOwners([owner, peer, crewMember, foreign]);
  const services = yield* Layer.build(Layer.mergeAll(ledgerLayer, crewInstanceLayer));
  yield* Context.get(services, A2ALedger).ensureProject({ projectId, createdAt: at });
  const register = (id: ThreadId, spawnedBy: string | null) =>
    Effect.gen(function* () {
      const participant = participantIdForThread(id);
      yield* sql`INSERT INTO j5_a2a_membership
        (project_id, participant_id, participant_kind, thread_id, joined_seq, updated_seq, payload)
        VALUES (${projectId}, ${participant}, 'agent', ${id}, 1, 1,
          ${JSON.stringify({ kind: "agent", id: participant, threadId: id })})`;
      if (spawnedBy !== null)
        yield* sql`INSERT INTO j5_a2a_participant_placement
          (project_id, participant_id, provenance_kind, provenance_participant_id,
            provenance_source, placement_parent_id, created_event_seq, updated_event_seq)
          VALUES (${projectId}, ${participant}, 'spawned-by', ${spawnedBy}, 'j5_spawn', ${spawnedBy}, 1, 1)`;
    });
  yield* register(owner, null);
  yield* register(peer, ownerId);
  yield* register(crewMember, null);
  yield* register(foreign, null);
  const crews = Context.get(services, AgentCrewInstanceService);
  yield* crews.record({
    id: "crew:runtime",
    projectId,
    captainParticipantId: ownerId,
    captainThreadId: owner,
    displayName: "Runtime Crew",
    brief: "Review together.",
    createdAt: at,
    members: [
      {
        seatName: "critic",
        agentId: null,
        participantId: crewId,
        threadId: crewMember,
        reason: null,
        playbookStepIds: [],
      },
    ],
  });
  const archived = yield* Ref.make(new Set<string>());
  const fault = yield* Ref.make(false);
  const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2Command>>([]);
  const threads = ThreadManagementService.of({
    getThreadRecords: (id: ThreadId) =>
      Ref.get(archived).pipe(
        Effect.flatMap((ids) =>
          [owner, peer, crewMember, foreign].includes(id)
            ? Effect.succeed(projection(id, ids.has(id)))
            : Effect.fail(
                new OrchestratorProjectionError({
                  threadId: id,
                  cause: new ProjectionStoreThreadNotFoundError({ threadId: id }),
                }),
              ),
        ),
      ),
    dispatch: (command: OrchestrationV2Command) =>
      Effect.gen(function* () {
        if (yield* Ref.get(fault))
          return yield* new OrchestratorDispatchError({
            commandId: "commandId" in command ? command.commandId : CommandId.make("missing"),
            commandType: command.type,
          });
        yield* Ref.update(dispatched, (rows) => [...rows, command]);
        return { sequence: 1, storedEvents: [] };
      }),
    stopDelegatedTasks: () => Effect.void,
  } as unknown as ThreadManagementService["Service"]);
  const store = yield* makePlaybookStore;
  const relay = yield* makePlaybookCrewRelay.pipe(
    Effect.provideService(PlaybookStore, store),
    Effect.provideService(ThreadManagementService, threads),
  );
  const notices = Ref.get(dispatched).pipe(
    Effect.map((rows) => rows.filter((row) => row.type === "message.dispatch")),
  );
  const start = (key: string, assignee?: string) =>
    relay.start({
      owner,
      root,
      name: "review",
      key,
      ...(assignee === undefined ? {} : { assignee }),
    });
  const move = (
    runId: string,
    operation: "next" | "back" | "assign",
    expectedStepId: string,
    key: string,
    assignee?: string,
  ) =>
    relay.mutate(owner, {
      runId,
      operation,
      expectedStepId,
      client_request_id: key,
      ...(assignee === undefined ? {} : { assignee }),
    });
  return { store, relay, start, move, notices, fault, archived, sql, threads, root };
});
const TestLayer = Layer.mergeAll(
  NodeSqliteClient.layer({ filename: ":memory:" }),
  NodeServices.layer,
  NodeCrypto.layer,
);
const code = (error: PlaybookError) => error.code;

it.effect("keeps an unassigned run with the owner and moves without a Crew", () =>
  Effect.gen(function* () {
    const { start, move, notices, relay } = yield* fixture;
    const run = yield* start("start-owner");
    assert.equal(run.holderParticipantId, ownerId);
    assert.equal(run.delivery?.state, "captain");
    assert.equal((yield* relay.current(owner, run.runId)).delivery?.state, "captain");
    const next = yield* move(run.runId, "next", "inspect", "next-owner");
    assert.equal(next.currentStepId, "review");
    assert.equal(next.delivery?.state, "captain");
    assert.lengthOf(yield* notices, 0);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("delivers fresh steps to a spawned Peer Agent and a Crew member", () =>
  Effect.gen(function* () {
    const { start, move, notices, relay } = yield* fixture;
    const run = yield* start("start-peer", peerId);
    assert.equal(run.delivery?.state, "delivered");
    assert.equal(run.delivery?.participantId, peerId);
    const next = yield* move(run.runId, "next", "inspect", "next-crew", crewId);
    assert.equal(next.delivery?.seat, "critic");
    assert.equal(next.delivery?.participantId, crewId);
    const sent = yield* notices;
    assert.deepStrictEqual(
      sent.map((row) => row.threadId),
      [peer, crewMember],
    );
    assert.include(sent[0]!.text, "<step_prompt>\nRead the change.\n</step_prompt>");
    assert.include(sent[0]!.text, `report back to ${ownerId}`);
    assert.equal((yield* relay.current(owner, run.runId)).holderParticipantId, crewId);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("refuses foreign and archived assignees without moving or recording a request", () =>
  Effect.gen(function* () {
    const { start, move, store, sql, archived } = yield* fixture;
    const run = yield* start("start-owner");
    yield* Ref.update(archived, (ids) => new Set([...ids, peer]));
    yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at = ${at} WHERE thread_id = ${peer}`;
    for (const assignee of [
      foreignId,
      peerId,
      "human:someone",
      "machine:automation",
      "agent:j5:a2a:missing",
    ]) {
      const refused = yield* move(run.runId, "next", "inspect", `bad:${assignee}`, assignee).pipe(
        Effect.flip,
      );
      assert.equal(code(refused), "invalid_assignee");
      assert.equal((yield* store.runById(run.runId))?.currentStepId, "inspect");
    }
    const other = yield* move(run.runId, "next", "inspect", "bad:foreign", foreignId).pipe(
      Effect.flip,
    );
    assert.equal(code(other), "invalid_assignee");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("a retry delivers once; the same request ID with another assignee conflicts", () =>
  Effect.gen(function* () {
    const { start, move, notices } = yield* fixture;
    const run = yield* start("start-peer", peerId);
    const replay = yield* start("start-peer", peerId);
    assert.isTrue(replay.replayed);
    assert.lengthOf(yield* notices, 1);
    assert.equal(code(yield* start("start-peer", crewId).pipe(Effect.flip)), "request_conflict");
    yield* move(run.runId, "next", "inspect", "next-crew", crewId);
    yield* move(run.runId, "next", "inspect", "next-crew", crewId);
    assert.lengthOf(yield* notices, 2);
    assert.equal(
      code(yield* move(run.runId, "next", "inspect", "next-crew", peerId).pipe(Effect.flip)),
      "request_conflict",
    );
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("assign replaces an archived pending target and old retries cannot revive it", () =>
  Effect.gen(function* () {
    const { start, move, relay, fault, notices, store, sql, archived } = yield* fixture;
    yield* Ref.set(fault, true);
    const run = yield* start("start-peer", peerId);
    assert.equal(run.delivery?.state, "pending");
    assert.equal((yield* relay.current(owner, run.runId)).delivery?.state, "pending");
    const blocked = yield* move(run.runId, "next", "inspect", "next-1").pipe(Effect.flip);
    assert.equal(code(blocked), "delivery_pending");
    yield* Ref.update(archived, (ids) => new Set([...ids, peer]));
    yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at = ${at} WHERE thread_id = ${peer}`;
    const invalid = yield* move(run.runId, "assign", "inspect", "bad-takeover", foreignId).pipe(
      Effect.flip,
    );
    assert.equal(code(invalid), "invalid_assignee");
    assert.equal((yield* store.landing(run.runId, "start-peer"))?.outcome, null);
    assert.equal((yield* store.runById(run.runId))?.holderParticipantId, peerId);
    const taken = yield* move(run.runId, "assign", "inspect", "take-back");
    assert.equal(taken.delivery?.state, "captain");
    assert.equal(taken.currentStepId, "inspect");
    assert.equal((yield* store.landing(run.runId, "start-peer"))?.outcome, "skipped");
    yield* Ref.set(fault, false);
    const old = yield* start("start-peer", peerId);
    assert.equal(old.delivery?.state, "captain");
    assert.lengthOf(yield* notices, 0);
    const next = yield* move(run.runId, "next", "inspect", "next-2", crewId);
    assert.equal(next.delivery?.state, "delivered");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("only the owner can move a run whose holder is another agent", () =>
  Effect.gen(function* () {
    const { start, relay } = yield* fixture;
    const run = yield* start("start-peer", peerId);
    const refusal = yield* relay
      .mutate(peer, {
        runId: run.runId,
        operation: "next",
        expectedStepId: "inspect",
        client_request_id: "peer-next",
      })
      .pipe(Effect.flip);
    assert.equal(code(refusal), "not_owner");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect.each([
  { startMode: "first", operation: "assign" },
  { startMode: "first", operation: "cancel" },
  { startMode: "retry", operation: "assign" },
  { startMode: "retry", operation: "cancel" },
] as const)(
  "serializes $operation with $startMode start delivery while other runs proceed",
  ({ startMode, operation }) =>
    Effect.gen(function* () {
      const { store, start, fault, threads, root, notices } = yield* fixture;
      if (startMode === "retry") {
        yield* Ref.set(fault, true);
        yield* start("start-race", peerId);
        yield* Ref.set(fault, false);
      }
      const dispatchEntered = yield* Deferred.make<void>();
      const releaseDispatch = yield* Deferred.make<void>();
      const runRead = yield* Deferred.make<void>();
      const mutationEntered = yield* Deferred.make<void>();
      const armed = yield* Ref.make(false);
      const relay = yield* makePlaybookCrewRelay.pipe(
        Effect.provideService(PlaybookStore, {
          ...store,
          runById: (id) =>
            store
              .runById(id)
              .pipe(
                Effect.tap(() =>
                  Ref.get(armed).pipe(
                    Effect.flatMap((active) =>
                      active ? Deferred.succeed(runRead, undefined) : Effect.void,
                    ),
                  ),
                ),
              ),
          mutate: (caller, input) =>
            Deferred.succeed(mutationEntered, undefined).pipe(
              Effect.andThen(store.mutate(caller, input)),
            ),
        }),
        Effect.provideService(ThreadManagementService, {
          ...threads,
          dispatch: (command) =>
            Deferred.succeed(dispatchEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseDispatch)),
              Effect.andThen(threads.dispatch(command)),
            ),
        }),
      );
      const starting = yield* relay
        .start({ owner, root, name: "review", key: "start-race", assignee: peerId })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(dispatchEntered);
      const current = yield* store.current(owner);
      yield* Ref.set(armed, true);
      const mutation = yield* relay
        .mutate(owner, {
          runId: current.runId,
          operation,
          expectedStepId: "inspect",
          client_request_id: "mutation-race",
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(runRead);
      const unrelated = yield* relay.start({
        owner: foreign,
        root,
        name: "review",
        key: "unrelated",
      });
      assert.equal(unrelated.delivery?.state, "captain");
      assert.isFalse(yield* Deferred.isDone(mutationEntered));
      assert.equal((yield* store.landing(current.runId, "start-race"))?.outcome, null);
      yield* Deferred.succeed(releaseDispatch, undefined);
      const started = yield* Fiber.join(starting);
      assert.equal(started.delivery?.state, "delivered");
      const changed = yield* Fiber.join(mutation);
      assert.equal(changed.status, operation === "cancel" ? "cancelled" : "active");
      assert.equal(changed.delivery?.state, operation === "assign" ? "captain" : undefined);
      assert.lengthOf(yield* notices, 1);
      assert.equal((yield* store.landing(current.runId, "start-race"))?.outcome, "delivered");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect(
  "a mutation winning the insertion-to-lock gap supersedes the start response and notice",
  () =>
    Effect.gen(function* () {
      const { store, threads, root, notices } = yield* fixture;
      const inserted = yield* Deferred.make<void>();
      const releaseStart = yield* Deferred.make<void>();
      const relay = yield* makePlaybookCrewRelay.pipe(
        Effect.provideService(PlaybookStore, {
          ...store,
          start: (...input) =>
            store
              .start(...input)
              .pipe(
                Effect.tap(() =>
                  Deferred.succeed(inserted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseStart)),
                  ),
                ),
              ),
        }),
        Effect.provideService(ThreadManagementService, threads),
      );
      const starting = yield* relay
        .start({ owner, root, name: "review", key: "start-gap", assignee: peerId })
        .pipe(Effect.forkChild);
      yield* Deferred.await(inserted);
      const run = yield* store.current(owner);
      yield* relay.mutate(owner, {
        runId: run.runId,
        operation: "assign",
        expectedStepId: "inspect",
        client_request_id: "take-back-gap",
      });
      yield* Deferred.succeed(releaseStart, undefined);
      const response = yield* Fiber.join(starting);
      assert.equal(response.holderParticipantId, ownerId);
      assert.equal(response.delivery?.state, "captain");
      assert.isFalse(response.replayed);
      assert.equal((yield* store.landing(run.runId, "start-gap"))?.outcome, "skipped");
      assert.lengthOf(yield* notices, 0);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("an upgraded owner-held run without landings still reports its recorded owner", () =>
  Effect.gen(function* () {
    const { start, store, relay, sql, notices } = yield* fixture;
    const run = yield* start("owner-before-upgrade");
    yield* sql`DELETE FROM j5_playbook_step_delivery WHERE run_id = ${run.runId}`;
    const current = yield* relay.current(owner, run.runId);
    assert.equal(current.delivery?.state, "captain");
    assert.equal(current.delivery?.participantId, ownerId);
    assert.lengthOf(yield* notices, 0);
    assert.isNull(yield* store.latestLanding(run.runId));
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect.each(["target", "owner"] as const)(
  "an unresolved upgraded $0 identity requires explicit recovery",
  (missing) =>
    Effect.gen(function* () {
      const { start, relay, fault, sql, notices, store, move } = yield* fixture;
      yield* Ref.set(fault, true);
      const run = yield* start("pending-before-upgrade", peerId);
      if (missing === "target") {
        yield* sql`UPDATE j5_playbook_run SET holder_participant_id = NULL WHERE run_id = ${run.runId}`;
        yield* sql`UPDATE j5_playbook_step_delivery SET target_participant_id = NULL WHERE run_id = ${run.runId}`;
      } else {
        yield* sql`UPDATE j5_playbook_run SET assigned_by_participant_id = NULL WHERE run_id = ${run.runId}`;
        yield* sql`UPDATE j5_playbook_step_delivery SET assigned_by_participant_id = NULL WHERE run_id = ${run.runId}`;
      }
      yield* Ref.set(fault, false);
      const unavailable = yield* relay.current(owner).pipe(Effect.flip);
      assert.equal(unavailable.code, "holder_unavailable");
      assert.include(unavailable.message, "j5_playbook_assign");
      assert.include(unavailable.message, `runId=${JSON.stringify(run.runId)}`);
      assert.include(unavailable.message, `expectedStepId=${JSON.stringify(run.currentStepId)}`);
      const blocked = yield* move(run.runId, "next", "inspect", "next-unresolved").pipe(
        Effect.flip,
      );
      assert.equal(blocked.code, "delivery_pending");
      assert.include(blocked.message, "recorded");
      assert.lengthOf(yield* notices, 0);
      assert.isNull((yield* store.landing(run.runId, "pending-before-upgrade"))?.resolvedAt);
      const recovered = yield* move(run.runId, "assign", "inspect", "recover-upgrade");
      assert.equal(recovered.delivery?.state, "captain");
      assert.equal(recovered.assignedByParticipantId, ownerId);
      assert.equal((yield* store.landing(run.runId, "pending-before-upgrade"))?.outcome, "skipped");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect(
  "revises a no-Crew run to a Peer once, preserves its holder, and can return it to the owner",
  () =>
    Effect.gen(function* () {
      const { start, relay, notices, store } = yield* fixture;
      const run = yield* start("revision-owner");
      const input = {
        operation: "revise" as const,
        runId: run.runId,
        expectedStepId: "inspect",
        client_request_id: "revise-peer",
        basis: "asked" as const,
        stepId: "review",
        assignee: peerId,
        steps: definition.steps
          .slice(1)
          .map((step) => ({ ...step, prompt: `Revised ${step.id}.` })),
      };
      const { assignee, ...unassigned } = input;
      const changed = yield* relay.mutate(owner, input);
      assert.equal(changed.currentStepId, "review");
      assert.equal(changed.holderParticipantId, assignee);
      assert.equal(changed.assignedByParticipantId, ownerId);
      assert.equal(changed.delivery?.state, "delivered");
      assert.equal(changed.currentStep?.prompt, "Revised review.");
      assert.equal(changed.revisionCount, 1);
      assert.include((yield* notices)[0]?.text, "Revised review.");
      assert.equal((yield* store.landing(run.runId, "revise-peer"))?.targetParticipantId, peerId);
      assert.isTrue((yield* relay.mutate(owner, input)).replayed);
      assert.lengthOf(yield* notices, 1);
      assert.equal(
        (yield* Effect.flip(relay.mutate(owner, { ...input, assignee: crewId }))).code,
        "request_conflict",
      );
      const edit = {
        ...unassigned,
        expectedStepId: "review",
        client_request_id: "edit-held",
        steps: input.steps.map((step) => ({ ...step, prompt: `Edited ${step.id}.` })),
      };
      const edited = yield* relay.mutate(owner, edit);
      assert.equal(edited.holderParticipantId, peerId);
      assert.equal(edited.delivery?.participantId, peerId);
      assert.equal(edited.currentStep?.prompt, "Edited review.");
      assert.equal((yield* store.landing(run.runId, "edit-held"))?.targetParticipantId, peerId);
      assert.include((yield* notices)[1]?.text, "Edited review.");
      assert.isTrue((yield* relay.mutate(owner, edit)).replayed);
      yield* relay.mutate(owner, {
        ...edit,
        client_request_id: "edit-later-step",
        steps: edit.steps.map((step) =>
          step.id === "report" ? { ...step, prompt: "New report." } : step,
        ),
      });
      assert.lengthOf(yield* notices, 2);
      const returned = yield* relay.mutate(owner, {
        ...unassigned,
        expectedStepId: "review",
        client_request_id: "return-owner",
        steps: input.steps.slice(1),
        stepId: "report",
      });
      assert.equal(returned.currentStepId, "report");
      assert.equal(returned.holderParticipantId, ownerId);
      assert.equal(returned.delivery?.state, "captain");
      assert.equal(returned.revisionCount, 4);
      assert.lengthOf(yield* notices, 2);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect(
  "invalid revision assignees leave the snapshot, history, pointer and holder unchanged",
  () =>
    Effect.gen(function* () {
      const { start, relay, store, sql, notices } = yield* fixture;
      const run = yield* start("held-start", peerId);
      const before = yield* store.runById(run.runId);
      const input = {
        operation: "revise" as const,
        runId: run.runId,
        expectedStepId: "inspect",
        client_request_id: "invalid-revision",
        basis: "approved" as const,
        steps: definition.steps.map((step) => ({ ...step, prompt: "Changed prompt." })),
        assignee: peerId,
      };
      assert.equal((yield* Effect.flip(relay.mutate(owner, input))).code, "invalid_assignee");
      assert.deepStrictEqual(yield* store.runById(run.runId), before);
      assert.equal(
        (yield* Effect.flip(
          relay.mutate(owner, {
            ...input,
            steps: input.steps.slice(1),
            stepId: "review",
            assignee: foreignId,
          }),
        )).code,
        "invalid_assignee",
      );
      assert.deepStrictEqual(yield* store.runById(run.runId), before);
      assert.lengthOf(
        yield* sql`SELECT * FROM j5_playbook_revision WHERE run_id = ${run.runId}`,
        0,
      );
      assert.lengthOf(
        yield* sql`SELECT * FROM j5_playbook_request WHERE request_id = 'invalid-revision'`,
        0,
      );
      assert.isNull(yield* store.landing(run.runId, "invalid-revision"));
      assert.lengthOf(yield* notices, 1);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("refuses pending, stale, foreign and terminal no-Crew revisions", () =>
  Effect.gen(function* () {
    const { start, relay, fault, store } = yield* fixture;
    yield* Ref.set(fault, true);
    const run = yield* start("pending-revision", peerId);
    const input = {
      operation: "revise" as const,
      runId: run.runId,
      expectedStepId: "inspect",
      client_request_id: "refused-revision",
      basis: "asked" as const,
      steps: definition.steps.slice(1),
      stepId: "review",
      assignee: peerId,
    };
    assert.equal((yield* Effect.flip(relay.mutate(owner, input))).code, "delivery_pending");
    assert.equal((yield* Effect.flip(relay.mutate(foreign, input))).code, "not_owner");
    assert.equal((yield* store.current(owner)).revisionCount, 0);
    yield* Ref.set(fault, false);
    assert.equal(
      (yield* Effect.flip(relay.mutate(owner, { ...input, expectedStepId: "stale" }))).code,
      "step_conflict",
    );
    assert.equal((yield* store.current(owner)).currentStepId, "inspect");
    yield* relay.mutate(owner, {
      operation: "cancel",
      runId: run.runId,
      client_request_id: "cancel-revision",
    });
    assert.equal((yield* Effect.flip(relay.mutate(owner, input))).code, "run_terminal");
    assert.equal((yield* store.current(owner)).revisionCount, 0);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);
