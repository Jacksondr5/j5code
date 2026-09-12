import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  A2AHomeRegistrar,
  participantIdForThread,
  layer as homeRegistrarLayer,
  transactionLayer as homeRegistrationTransactionLayer,
} from "./HomeRegistrar.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { ParticipantPlacementService, layer as placementLayer } from "./PlacementService.ts";
import { A2ASendService, layer as sendServiceLayer } from "./SendService.ts";
import { SquadronJoinService, layer as squadronJoinLayer } from "./SquadronJoinService.ts";
import {
  SquadronProjectReferences,
  layer as squadronProjectReferencesLayer,
} from "./SquadronProjectReferences.ts";
import { CommCommandId, SquadronId } from "./contracts.ts";
import { PlacementCommandId } from "./placementContracts.ts";

const createdAt = "2026-09-12T10:00:00.000Z";
const joinedAt = "2026-09-12T10:05:00.000Z";
const projectId = ProjectId.make("project:join:primary");
const otherProjectId = ProjectId.make("project:join:other");

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
const TestLayer = Layer.mergeAll(
  database,
  ledger,
  homes,
  homeTransactions,
  placements,
  references,
  sendService,
  join,
);

const seedSquadron = Effect.fn("test.j5.join.seedSquadron")(function* (
  squadronId: SquadronId,
  projectIds: ReadonlyArray<ProjectId>,
) {
  const ledgerService = yield* A2ALedger;
  yield* ledgerService.createSquadron({
    squadron: { id: squadronId, name: `Join ${squadronId}`, createdAt },
  });
  yield* (yield* SquadronProjectReferences).replaceForSquadron({
    squadronId,
    projectIds,
    createdAt,
  });
});

const inputFor = (input: {
  readonly name: string;
  readonly squadronId: SquadronId;
  readonly threadId: ThreadId;
  readonly projectId?: ProjectId;
}) => ({
  homeCommandId: CommCommandId.make(`command:join-home:${input.name}`),
  placementCommandId: PlacementCommandId.make(`command:join-placement:${input.name}`),
  squadronId: input.squadronId,
  threadId: input.threadId,
  projectId: input.projectId ?? projectId,
  joinedAt,
});

const countJoined = Effect.fn("test.j5.join.countJoined")(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count
    FROM j5_a2a_comm_event
    WHERE kind = 'participant.joined'
      AND json_extract(payload, '$.participant.threadId') = ${threadId}
  `;
  return rows[0]?.count ?? 0;
});

const countPlacements = Effect.fn("test.j5.join.countPlacements")(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count
    FROM j5_a2a_placement_event
    WHERE participant_id = ${participantIdForThread(threadId)}
  `;
  return rows[0]?.count ?? 0;
});

it.effect("gives an unregistered thread its home and root placement, then replays harmlessly", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const service = yield* SquadronJoinService;
    const squadronId = SquadronId.make("squadron:join:fresh");
    const threadId = ThreadId.make("thread:join:fresh");
    yield* seedSquadron(squadronId, [projectId]);
    const sendServiceLive = yield* A2ASendService;
    const before = yield* Effect.flip(sendServiceLive.listParticipants(threadId));
    assert.equal(before._tag, "A2ASenderNotJoinedError");

    const first = yield* service.joinExistingThread(
      inputFor({ name: "fresh", squadronId, threadId }),
    );
    assert.deepStrictEqual(first.home, {
      squadronId,
      participantId: participantIdForThread(threadId),
    });
    assert.deepStrictEqual(first.placement.provenance, {
      kind: "unknown",
      source: "native_or_unobserved",
    });
    assert.equal(first.placement.placementParentId, null);

    const sameCommand = yield* service.joinExistingThread(
      inputFor({ name: "fresh", squadronId, threadId }),
    );
    const differentCommand = yield* service.joinExistingThread(
      inputFor({ name: "fresh-retry", squadronId, threadId }),
    );
    assert.deepStrictEqual(sameCommand, first);
    assert.deepStrictEqual(differentCommand, first);
    assert.equal(yield* countJoined(threadId), 1);
    assert.equal(yield* countPlacements(threadId), 1);

    const home = yield* (yield* A2AHomeRegistrar).getHomeForThread(threadId);
    assert.deepStrictEqual(home, first.home);
    const directory = yield* sendServiceLive.listParticipants(threadId);
    assert.deepStrictEqual(
      directory.filter((row) => row.participant.kind === "agent").map((row) => row.participantId),
      [first.home.participantId],
    );
    const placementView = yield* (yield* ParticipantPlacementService).listParticipants(squadronId);
    assert.deepStrictEqual(placementView[0]?.provenance, {
      kind: "unknown",
      source: "native_or_unobserved",
    });
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("serializes concurrent joins with distinct command ids to one registration", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const service = yield* SquadronJoinService;
    const squadronId = SquadronId.make("squadron:join:concurrent");
    const threadId = ThreadId.make("thread:join:concurrent");
    yield* seedSquadron(squadronId, [projectId]);

    const results = yield* Effect.all(
      [
        service.joinExistingThread(inputFor({ name: "concurrent-a", squadronId, threadId })),
        service.joinExistingThread(inputFor({ name: "concurrent-b", squadronId, threadId })),
        service.joinExistingThread(inputFor({ name: "concurrent-c", squadronId, threadId })),
      ],
      { concurrency: "unbounded" },
    );
    assert.deepStrictEqual(results[1], results[0]);
    assert.deepStrictEqual(results[2], results[0]);
    assert.equal(yield* countJoined(threadId), 1);
    assert.equal(yield* countPlacements(threadId), 1);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("records root placement for a thread already homed without placement", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const service = yield* SquadronJoinService;
    const squadronId = SquadronId.make("squadron:join:launch-homed");
    const threadId = ThreadId.make("thread:join:launch-homed");
    yield* seedSquadron(squadronId, [projectId]);
    const launched = yield* (yield* A2AHomeRegistrar).registerAtCreation({
      commandId: CommCommandId.make("command:join:launch-home"),
      squadronId,
      threadId,
      createdAt,
    });

    const result = yield* service.joinExistingThread(
      inputFor({ name: "launch-homed", squadronId, threadId }),
    );
    assert.deepStrictEqual(result.home, launched);
    assert.equal(result.placement.placementParentId, null);
    assert.equal(yield* countJoined(threadId), 1);
    assert.equal(yield* countPlacements(threadId), 1);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("refuses a Squadron that does not reference exactly the thread's project", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const service = yield* SquadronJoinService;
    const otherSquadron = SquadronId.make("squadron:join:other-project");
    const emptySquadron = SquadronId.make("squadron:join:no-project");
    const missingSquadron = SquadronId.make("squadron:join:missing");
    const threadId = ThreadId.make("thread:join:project-mismatch");
    yield* seedSquadron(otherSquadron, [otherProjectId]);
    yield* seedSquadron(emptySquadron, []);

    const mismatch = yield* Effect.flip(
      service.joinExistingThread(
        inputFor({ name: "mismatch", squadronId: otherSquadron, threadId }),
      ),
    );
    assert.equal(mismatch._tag, "SquadronJoinProjectReferenceError");
    assert.include(mismatch.message, otherProjectId);
    assert.include(mismatch.message, "list_squadrons");

    const empty = yield* Effect.flip(
      service.joinExistingThread(inputFor({ name: "empty", squadronId: emptySquadron, threadId })),
    );
    assert.equal(empty._tag, "SquadronJoinProjectReferenceError");

    const missing = yield* Effect.flip(
      service.joinExistingThread(
        inputFor({ name: "missing", squadronId: missingSquadron, threadId }),
      ),
    );
    assert.equal(missing._tag, "SquadronProjectReferenceSquadronNotFoundError");
    assert.equal(yield* countJoined(threadId), 0);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("refuses a different existing home instead of moving the thread", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const service = yield* SquadronJoinService;
    const homeSquadron = SquadronId.make("squadron:join:home");
    const requestedSquadron = SquadronId.make("squadron:join:requested");
    const threadId = ThreadId.make("thread:join:conflict");
    yield* seedSquadron(homeSquadron, [projectId]);
    yield* seedSquadron(requestedSquadron, [projectId]);
    yield* service.joinExistingThread(
      inputFor({ name: "conflict-home", squadronId: homeSquadron, threadId }),
    );

    const conflict = yield* Effect.flip(
      service.joinExistingThread(
        inputFor({ name: "conflict-move", squadronId: requestedSquadron, threadId }),
      ),
    );
    assert.equal(conflict._tag, "A2AHomeConflictError");
    assert.equal(yield* countJoined(threadId), 1);
    const home = yield* (yield* A2AHomeRegistrar).getHomeForThread(threadId);
    assert.equal(home.squadronId, homeSquadron);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("refuses to revive a retired participant", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const service = yield* SquadronJoinService;
    const squadronId = SquadronId.make("squadron:join:retired");
    const threadId = ThreadId.make("thread:join:retired");
    yield* seedSquadron(squadronId, [projectId]);
    const joined = yield* service.joinExistingThread(
      inputFor({ name: "retired", squadronId, threadId }),
    );
    yield* (yield* A2ALedger).append({
      commandId: CommCommandId.make("command:join:retire"),
      squadronId,
      acceptedAt: joinedAt,
      event: {
        kind: "participant.left",
        sender: null,
        receiver: joined.home.participantId,
        exchangeId: null,
        correlationId: null,
        payload: {
          participant: { kind: "agent", id: joined.home.participantId, threadId },
        },
        createdAt: joinedAt,
      },
    });

    const revival = yield* Effect.flip(
      service.joinExistingThread(inputFor({ name: "retired-again", squadronId, threadId })),
    );
    assert.equal(revival._tag, "SquadronJoinRetiredError");
    assert.equal(yield* countJoined(threadId), 1);
  }).pipe(Effect.provide(TestLayer)),
);
