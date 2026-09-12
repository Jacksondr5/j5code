import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import {
  OrchestratorProjectionError,
  OrchestratorV2,
} from "../../../orchestration-v2/Orchestrator.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { ArchiveAgentService } from "../ArchiveAgentService.ts";
import { A2ADeliveryWorker } from "../DeliveryWorker.ts";
import {
  A2AHomeRegistrar,
  participantIdForThread,
  layer as homeRegistrarLayer,
  transactionLayer as homeRegistrationTransactionLayer,
} from "../HomeRegistrar.ts";
import { A2ALedger, layer as ledgerLayer } from "../LedgerService.ts";
import { runJ5A2AMigrations } from "../Migrations.ts";
import { layer as placementLayer } from "../PlacementService.ts";
import { layer as sendServiceLayer } from "../SendService.ts";
import { SpawnCompositionService } from "../SpawnCompositionService.ts";
import { layer as squadronJoinLayer } from "../SquadronJoinService.ts";
import {
  SquadronProjectReferences,
  layer as squadronProjectReferencesLayer,
} from "../SquadronProjectReferences.ts";
import { SquadronId } from "../contracts.ts";
import { J5ToolkitHandlersLive } from "./handlers.ts";
import {
  J5JoinSquadronResult,
  J5ListParticipantsResult,
  J5ListSquadronsResult,
  J5Toolkit,
  type J5JoinSquadronInput,
} from "./tools.ts";

const decodeJoinResult = Schema.decodeUnknownEffect(J5JoinSquadronResult);
const decodeListSquadronsResult = Schema.decodeUnknownEffect(J5ListSquadronsResult);
const decodeListParticipantsResult = Schema.decodeUnknownEffect(J5ListParticipantsResult);

const createdAt = "2026-09-12T10:00:00.000Z";
const projectId = ProjectId.make("project:j5:join-tool");
const otherProjectId = ProjectId.make("project:j5:join-tool-other");
const nativeThreadId = ThreadId.make("thread:j5:join-tool:native");
const archivedThreadId = ThreadId.make("thread:j5:join-tool:archived");
const squadronId = SquadronId.make("squadron:j5:join-tool");
const otherSquadronId = SquadronId.make("squadron:j5:join-tool-other");

const scopeFor = (threadId: ThreadId) => ({
  environmentId: EnvironmentId.make("environment:j5:join-tool"),
  threadId,
  providerSessionId: "provider-session:j5:join-tool",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["orchestration"] as const),
  issuedAt: 1,
});

const projection = (threadId: ThreadId): OrchestrationV2ThreadProjection =>
  ({
    thread: {
      id: threadId,
      projectId,
      title: `Title ${threadId}`,
      createdAt: DateTime.makeUnsafe(createdAt),
      archivedAt: threadId === archivedThreadId ? DateTime.makeUnsafe(createdAt) : null,
      deletedAt: null,
    },
  }) as unknown as OrchestrationV2ThreadProjection;

const database = NodeSqliteClient.layerMemory();
const ledger = ledgerLayer.pipe(Layer.provide(database));
const homes = homeRegistrarLayer.pipe(Layer.provide(ledger), Layer.provide(database));
const homeTransactions = homeRegistrationTransactionLayer.pipe(
  Layer.provide(ledger),
  Layer.provide(database),
);
const placements = placementLayer.pipe(Layer.provide(ledger), Layer.provide(database));
const references = squadronProjectReferencesLayer.pipe(Layer.provide(database));
const sendService = sendServiceLayer.pipe(Layer.provide(ledger), Layer.provide(database));
const join = squadronJoinLayer.pipe(
  Layer.provide(homeTransactions),
  Layer.provide(ledger),
  Layer.provide(placements),
  Layer.provide(references),
  Layer.provide(database),
);
const realA2A = Layer.mergeAll(
  database,
  ledger,
  homes,
  homeTransactions,
  placements,
  references,
  sendService,
  join,
);
const dependencies = Layer.mergeAll(
  realA2A,
  Layer.mock(ThreadManagementService)({
    getThreadProjection: (threadId) => Effect.succeed(projection(threadId)),
  }),
  Layer.mock(OrchestratorV2)({
    getShellSnapshot: () =>
      Effect.fail(new OrchestratorProjectionError({ threadId: nativeThreadId })),
  }),
  Layer.mock(OrchestratorMcpService)({}),
  Layer.mock(SpawnCompositionService)({}),
  Layer.mock(ArchiveAgentService)({}),
  Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
  NodeServices.layer,
);
const TestLayer = J5ToolkitHandlersLive.pipe(Layer.provideMerge(dependencies));

const provideScope = (threadId: ThreadId) =>
  Effect.provideService(McpInvocationContext, scopeFor(threadId));

const callJoin = (threadId: ThreadId, input: J5JoinSquadronInput) =>
  Effect.gen(function* () {
    const toolkit = yield* J5Toolkit;
    return yield* toolkit
      .handle("join_squadron", input)
      .pipe(
        Stream.unwrap,
        Stream.run(Sink.last()),
        Effect.flatMap(Effect.fromOption),
        provideScope(threadId),
      );
  });

const callListSquadrons = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const toolkit = yield* J5Toolkit;
    return yield* toolkit
      .handle("list_squadrons", {})
      .pipe(
        Stream.unwrap,
        Stream.run(Sink.last()),
        Effect.flatMap(Effect.fromOption),
        provideScope(threadId),
      );
  });

const callListParticipants = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const toolkit = yield* J5Toolkit;
    return yield* toolkit
      .handle("list_participants", {})
      .pipe(
        Stream.unwrap,
        Stream.run(Sink.last()),
        Effect.flatMap(Effect.fromOption),
        provideScope(threadId),
      );
  });

const seedSquadrons = Effect.gen(function* () {
  const ledgerService = yield* A2ALedger;
  const referenceService = yield* SquadronProjectReferences;
  yield* ledgerService.createSquadron({
    squadron: { id: squadronId, name: "J5 Code", createdAt },
  });
  yield* referenceService.replaceForSquadron({ squadronId, projectIds: [projectId], createdAt });
  yield* ledgerService.createSquadron({
    squadron: { id: otherSquadronId, name: "Elsewhere", createdAt },
  });
  yield* referenceService.replaceForSquadron({
    squadronId: otherSquadronId,
    projectIds: [otherProjectId],
    createdAt,
  });
});

const countJoined = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM j5_a2a_comm_event
      WHERE kind = 'participant.joined'
        AND json_extract(payload, '$.participant.threadId') = ${threadId}
    `;
    return rows[0]?.count ?? 0;
  });

it.effect("lets an unregistered caller find, join, and then list its Squadron", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    yield* seedSquadrons;

    const refused = yield* callListParticipants(nativeThreadId);
    assert.isTrue(refused.isFailure);
    assert.equal((refused.result as { readonly code: string }).code, "A2ASenderNotJoinedError");
    assert.include((refused.result as { readonly message: string }).message, "join_squadron");

    const directory = yield* callListSquadrons(nativeThreadId).pipe(
      Effect.flatMap((response) => decodeListSquadronsResult(response.result)),
    );
    assert.equal(directory.caller_project_id, projectId);
    assert.deepStrictEqual(directory.squadrons, [
      { squadron_id: squadronId, name: "J5 Code", project_ids: [projectId] },
      { squadron_id: otherSquadronId, name: "Elsewhere", project_ids: [otherProjectId] },
    ]);

    const wrongProject = yield* callJoin(nativeThreadId, {
      squadron_id: otherSquadronId,
      client_request_id: "join-wrong-project",
    });
    assert.isTrue(wrongProject.isFailure);
    assert.equal(
      (wrongProject.result as { readonly code: string }).code,
      "SquadronJoinProjectReferenceError",
    );
    assert.equal(yield* countJoined(nativeThreadId), 0);

    const input = {
      squadron_id: squadronId,
      client_request_id: "join-1",
    } satisfies J5JoinSquadronInput;
    const first = yield* callJoin(nativeThreadId, input);
    assert.isFalse(first.isFailure);
    const joined = yield* decodeJoinResult(first.result);
    assert.deepStrictEqual(joined, {
      squadron_id: squadronId,
      participant_id: participantIdForThread(nativeThreadId),
      thread_id: nativeThreadId,
      placement: {
        placement_parent_id: null,
        provenance: { kind: "unknown", source: "native_or_unobserved" },
      },
    });

    const replay = yield* callJoin(nativeThreadId, input);
    const freshKey = yield* callJoin(nativeThreadId, { squadron_id: squadronId });
    assert.deepStrictEqual(replay.result, first.result);
    assert.deepStrictEqual(freshKey.result, first.result);
    assert.equal(yield* countJoined(nativeThreadId), 1);

    const home = yield* (yield* A2AHomeRegistrar).getHomeForThread(nativeThreadId);
    assert.equal(home.squadronId, squadronId);
    const participants = yield* callListParticipants(nativeThreadId).pipe(
      Effect.flatMap((response) => decodeListParticipantsResult(response.result)),
    );
    const self = participants.participants.find((row) => row.self);
    assert.equal(self?.participant_id, joined.participant_id);
    assert.equal(self?.squadron_id, squadronId);
    assert.deepStrictEqual(self?.provenance, { kind: "unknown", source: "native_or_unobserved" });
    assert.equal(self?.placement_parent_id, null);

    const move = yield* callJoin(nativeThreadId, { squadron_id: otherSquadronId });
    assert.isTrue(move.isFailure);
    assert.equal((move.result as { readonly code: string }).code, "A2AHomeConflictError");
    assert.equal(yield* countJoined(nativeThreadId), 1);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("refuses an archived caller before touching the ledger", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    yield* seedSquadrons;

    const refused = yield* callJoin(archivedThreadId, { squadron_id: squadronId });
    assert.isTrue(refused.isFailure);
    assert.include((refused.result as { readonly message: string }).message, "archived");
    assert.equal(yield* countJoined(archivedThreadId), 0);
    const lookup = yield* Effect.option(
      (yield* A2AHomeRegistrar).getHomeForThread(archivedThreadId),
    );
    assert.isTrue(Option.isNone(lookup));
  }).pipe(Effect.provide(TestLayer)),
);
