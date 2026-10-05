import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  ProjectId,
  ThreadId,
  type Project,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { AssignImportedThreadsResponse } from "@t3tools/contracts/j5";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlError, ConnectionError } from "effect/unstable/sql/SqlError";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { A2AHomeRegistrar, layer as homesLayer, transactionLayer } from "./HomeRegistrar.ts";
import { assignImportedThreads, importedThreadsHttpRouteLayer } from "./ImportedThreadsHttp.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { ParticipantPlacementService, layer as placementLayer } from "./PlacementService.ts";
import { SquadronJoinService, layer as joinLayer } from "./SquadronJoinService.ts";
import {
  SquadronProjectReferences,
  layer as referencesLayer,
} from "./SquadronProjectReferences.ts";
import { CommCommandId, SquadronId } from "./contracts.ts";
import { PlacementCommandId } from "./placementContracts.ts";

const projectId = ProjectId.make("project:import");
const squadronId = SquadronId.make("squadron:import");
const elsewhere = SquadronId.make("squadron:elsewhere");
const at = "2026-09-17T00:00:00.000Z";
const imported = ThreadId.make("import:codex:fresh");
const native = ThreadId.make("thread:native");
const homedElsewhere = ThreadId.make("import:codex:elsewhere");
const retired = ThreadId.make("import:codex:retired");
const archived = ThreadId.make("import:codex:archived");

// Only the orchestration read boundary is mocked; assignment uses the real SQLite ledger.
const shell = (id: ThreadId): OrchestrationV2ThreadShell =>
  ({
    id,
    projectId,
    historyOrigin: id === native ? undefined : "v1_import",
    archivedAt: id === archived ? DateTime.makeUnsafe(at) : null,
    deletedAt: null,
  }) as OrchestrationV2ThreadShell;
const threads = Layer.mock(ThreadManagementService)({
  listProjectThreads: () =>
    Effect.succeed([imported, native, homedElsewhere, retired, archived].map(shell)),
  getThreadShell: (threadId) => Effect.succeed(shell(threadId)),
});
const projects = Layer.mock(ProjectService)({
  getById: (id) =>
    Effect.succeed(id === projectId ? Option.some({ id } as Project) : Option.none()),
});
const db = NodeSqliteClient.layer({ filename: ":memory:" });
const ledger = ledgerLayer.pipe(Layer.provide(db));
const homes = homesLayer.pipe(Layer.provide(ledger), Layer.provide(db));
const transactions = transactionLayer.pipe(Layer.provide(ledger), Layer.provide(db));
const placements = placementLayer.pipe(Layer.provide(ledger), Layer.provide(db));
const references = referencesLayer.pipe(Layer.provide(db));
const join = joinLayer.pipe(
  Layer.provide(transactions),
  Layer.provide(ledger),
  Layer.provide(placements),
  Layer.provide(references),
  Layer.provide(db),
);
const TestLayer = Layer.mergeAll(
  db,
  ledger,
  homes,
  placements,
  references,
  join,
  threads,
  projects,
);

const joinInput = (threadId: ThreadId, home = squadronId) => ({
  threadId,
  squadronId: home,
  projectId,
  joinedAt: at,
  homeCommandId: CommCommandId.make(`seed:home:${threadId}`),
  placementCommandId: PlacementCommandId.make(`seed:placement:${threadId}`),
});
const seed = Effect.gen(function* () {
  yield* runJ5A2AMigrations();
  const ledgerService = yield* A2ALedger;
  for (const id of [squadronId, elsewhere]) {
    yield* ledgerService.createSquadron({ squadron: { id, name: id, createdAt: at } });
    yield* (yield* SquadronProjectReferences).replaceForSquadron({
      squadronId: id,
      projectIds: [projectId],
      createdAt: at,
    });
  }
  const joinService = yield* SquadronJoinService;
  yield* joinService.joinExistingThread(joinInput(homedElsewhere, elsewhere));
  const old = yield* joinService.joinExistingThread(joinInput(retired));
  yield* ledgerService.append({
    commandId: CommCommandId.make("seed:retire"),
    squadronId,
    acceptedAt: at,
    event: {
      kind: "participant.left",
      sender: null,
      receiver: old.home.participantId,
      exchangeId: null,
      correlationId: null,
      createdAt: at,
      payload: { participant: { kind: "agent", id: old.home.participantId, threadId: retired } },
    },
  });
});
const counts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM j5_a2a_comm_event`;
  const placements = yield* sql<{
    count: number;
  }>`SELECT COUNT(*) AS count FROM j5_a2a_placement_event`;
  return [events[0]?.count, placements[0]?.count];
});

it.effect(
  "assigns imported conversations only, preserves homes and retirement, and retries without new facts",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const first = yield* assignImportedThreads({ squadronId, projectId });
      assert.deepStrictEqual(first.entries, [
        { threadId: imported, status: "assigned" },
        { threadId: homedElsewhere, status: "kept_elsewhere" },
        { threadId: retired, status: "kept_retired" },
        { threadId: archived, status: "kept_archived" },
      ]);
      const before = yield* counts;
      const repeated = yield* assignImportedThreads({ squadronId, projectId });
      assert.equal(repeated.entries[0]?.status, "already_assigned");
      assert.deepStrictEqual(yield* counts, before);
      const homeService = yield* A2AHomeRegistrar;
      assert.equal((yield* homeService.getHomeForThread(imported)).squadronId, squadronId);
      assert.equal((yield* homeService.getHomeForThread(homedElsewhere)).squadronId, elsewhere);
      assert.equal(
        (yield* Effect.flip(homeService.getHomeForThread(native)))._tag,
        "A2AHomeNotFoundError",
      );
      assert.equal(
        (yield* Effect.flip(homeService.getHomeForThread(archived)))._tag,
        "A2AHomeNotFoundError",
      );
      const home = yield* homeService.getHomeForThread(imported);
      const placement = yield* (yield* ParticipantPlacementService).readPlacement({
        squadronId,
        participantId: home.participantId,
      });
      assert.deepStrictEqual(placement?.provenance, {
        kind: "unknown",
        source: "native_or_unobserved",
      });
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("concurrent requests to different Squadrons choose exactly one immutable home", () =>
  Effect.gen(function* () {
    yield* seed;
    const results = yield* Effect.all(
      [
        assignImportedThreads({ squadronId, projectId }),
        assignImportedThreads({ squadronId: elsewhere, projectId }),
      ],
      { concurrency: 2 },
    );
    const outcomes = results
      .flatMap((result) =>
        result.entries.filter((entry) => entry.threadId === imported).map((entry) => entry.status),
      )
      .sort();
    assert.deepStrictEqual(outcomes, ["assigned", "kept_elsewhere"]);
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      count: number;
    }>`SELECT COUNT(*) AS count FROM j5_a2a_comm_event WHERE kind = 'participant.joined' AND json_extract(payload, '$.participant.threadId') = ${imported}`;
    assert.equal(rows[0]?.count, 1);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("reports a failed assignment without exposing storage details and allows retry", () =>
  Effect.gen(function* () {
    yield* seed;
    const real = yield* SquadronJoinService;
    const result = yield* assignImportedThreads({ squadronId, projectId }).pipe(
      Effect.provideService(SquadronJoinService, {
        joinExistingThread: (input) =>
          input.threadId === imported
            ? Effect.fail(
                new SqlError({
                  reason: new ConnectionError({
                    message: "private database detail",
                    cause: new Error("private database detail"),
                  }),
                }),
              )
            : real.joinExistingThread(input),
      }),
    );
    assert.deepStrictEqual(result.entries[0], { threadId: imported, status: "failed" });
    assert.equal(result.entries[1]?.status, "kept_elsewhere");
    const retried = yield* assignImportedThreads({ squadronId, projectId });
    assert.equal(retried.entries[0]?.status, "assigned");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("validates the target project and Squadron reference before any assignment", () =>
  Effect.gen(function* () {
    yield* seed;
    const before = yield* counts;
    const missing = yield* Effect.flip(
      assignImportedThreads({ squadronId, projectId: ProjectId.make("missing") }),
    );
    assert.equal(missing._tag, "SquadronProjectNotFoundError");
    yield* (yield* SquadronProjectReferences).replaceForSquadron({
      squadronId,
      projectIds: [],
      createdAt: at,
    });
    const mismatch = yield* Effect.flip(assignImportedThreads({ squadronId, projectId }));
    assert.equal(mismatch._tag, "SquadronJoinProjectReferenceError");
    assert.deepStrictEqual(yield* counts, before);
  }).pipe(Effect.provide(TestLayer)),
);

it("requires operate scope and validates JSON at the HTTP boundary", async () => {
  const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: (request) =>
      Effect.succeed({
        sessionId: AuthSessionId.make("auth:import"),
        subject: "test",
        method: "bearer-access-token",
        scopes:
          request.headers["x-operate"] === "yes"
            ? [AuthOrchestrationOperateScope]
            : [AuthOrchestrationReadScope],
      }),
  });
  const routes = importedThreadsHttpRouteLayer.pipe(
    Layer.provide(Layer.effectDiscard(seed).pipe(Layer.provideMerge(TestLayer))),
    Layer.provideMerge(auth),
    Layer.provide(HttpServer.layerServices),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  const request = (body: unknown, operate = false) =>
    new Request("http://remote.test/api/j5/squadrons/assign-imported", {
      method: "POST",
      headers: { "content-type": "application/json", ...(operate ? { "x-operate": "yes" } : {}) },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await handler(request({ squadronId, projectId }))).status, 403);
    assert.equal((await handler(request({ squadronId }, true))).status, 400);
    assert.equal((await handler(request({ squadronId: "unknown", projectId }, true))).status, 404);
    const response = await handler(request({ squadronId, projectId }, true));
    assert.equal(response.status, 200);
    const decode = Schema.decodeUnknownSync(AssignImportedThreadsResponse);
    const body = decode(await response.json());
    assert.equal(body.entries[0]?.status, "assigned");
    const retry = await handler(request({ squadronId, projectId }, true));
    assert.equal(decode(await retry.json()).entries[0]?.status, "already_assigned");
  } finally {
    await dispose();
  }
});
