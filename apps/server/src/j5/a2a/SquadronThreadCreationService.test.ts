import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { A2AHomeConflictError, A2AHomeRegistrar } from "./HomeRegistrar.ts";
import {
  SquadronThreadCreationMissingSquadronError,
  SquadronThreadCreationProjectReferenceError,
  SquadronThreadCreationService,
  layer as squadronThreadCreationServiceLayer,
} from "./SquadronThreadCreationService.ts";
import { SquadronProjectReferences } from "./SquadronProjectReferences.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import { ParticipantId, SquadronId } from "./contracts.ts";

const squadronId = SquadronId.make("squadron:creation");
const projectId = ProjectId.make("project:creation");
const otherProjectId = ProjectId.make("project:other");
const threadId = ThreadId.make("thread:creation");
const createdAt = DateTime.makeUnsafe("2026-08-29T20:00:00.000Z");

const launchInput = {
  commandId: CommandId.make("command:creation"),
  projectId,
} as ThreadLaunch.ThreadLaunchInput;

const launchResult = {
  threadId,
  projection: { thread: { createdAt } },
  resumed: false,
} as ThreadLaunch.ThreadLaunchResult;

const database = NodeSqliteClient.layerMemory();

const makeLayer = (input: {
  readonly references: ReadonlyArray<ProjectId>;
  readonly launch?: ThreadLaunch.ThreadLaunchService["Service"]["launch"];
  readonly register?: A2AHomeRegistrar["Service"]["registerAtCreation"];
}) => {
  const references = Layer.mock(SquadronProjectReferences)({
    listForSquadron: () =>
      Effect.succeed(
        input.references.map((candidateProjectId, ordinal) => ({
          squadronId,
          projectId: candidateProjectId,
          ordinal,
          createdAt: "2026-08-29T20:00:00.000Z",
        })),
      ),
  });
  const launcher = Layer.mock(ThreadLaunch.ThreadLaunchService)({
    launch: input.launch ?? (() => Effect.succeed(launchResult)),
  });
  const registrar = Layer.mock(A2AHomeRegistrar)({
    registerAtCreation:
      input.register ??
      (() =>
        Effect.succeed({
          squadronId,
          participantId: ParticipantId.make(`agent:${threadId}`),
        })),
  });
  return squadronThreadCreationServiceLayer.pipe(
    Layer.provideMerge(references),
    Layer.provideMerge(launcher),
    Layer.provideMerge(registrar),
    Layer.provideMerge(database),
  );
};

it.effect("refuses a thread creation without an explicit Squadron before launch", () =>
  Effect.gen(function* () {
    const service = yield* SquadronThreadCreationService;
    const error = yield* service.create({ launch: launchInput }).pipe(Effect.flip);
    assert.instanceOf(error, SquadronThreadCreationMissingSquadronError);
  }).pipe(Effect.provide(makeLayer({ references: [projectId] }))),
);

it.effect("refuses unreferenced and ambiguous project selections without inferring a project", () =>
  Effect.gen(function* () {
    const service = yield* SquadronThreadCreationService;
    const error = yield* service.create({ squadronId, launch: launchInput }).pipe(Effect.flip);
    assert.instanceOf(error, SquadronThreadCreationProjectReferenceError);
    assert.deepStrictEqual(error.referencedProjectIds, [otherProjectId, projectId]);
  }).pipe(Effect.provide(makeLayer({ references: [otherProjectId, projectId] }))),
);

it.effect("uses canonical launch then rolls it back when home registration fails", () => {
  let probeSql: SqlClient.SqlClient | undefined;
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    probeSql = sql;
    yield* sql`CREATE TABLE creation_probe (value TEXT NOT NULL)`;
    const service = yield* SquadronThreadCreationService;
    const error = yield* service.create({ squadronId, launch: launchInput }).pipe(Effect.flip);
    assert.instanceOf(error, A2AHomeConflictError);
    assert.deepStrictEqual(
      yield* sql<{ readonly value: string }>`SELECT value FROM creation_probe`,
      [],
    );
  }).pipe(
    Effect.provide(
      makeLayer({
        references: [projectId],
        launch: () => {
          if (probeSql === undefined) return Effect.die("test database was not initialized");
          return probeSql`INSERT INTO creation_probe (value) VALUES ('launched')`.pipe(
            Effect.mapError(
              (cause) =>
                new ThreadLaunch.ThreadLaunchError({
                  operation: "create-thread",
                  commandId: launchInput.commandId,
                  projectId,
                  cause,
                }),
            ),
            Effect.as(launchResult),
          );
        },
        register: () =>
          Effect.fail(
            new A2AHomeConflictError({
              threadId,
              existingSquadronId: SquadronId.make("squadron:existing"),
              requestedSquadronId: squadronId,
            }),
          ),
      }),
    ),
  );
});

it.effect("derives stable registration inputs from the durable launch projection", () => {
  const registrations: Array<unknown> = [];
  return Effect.gen(function* () {
    const service = yield* SquadronThreadCreationService;
    yield* service.create({ squadronId, launch: launchInput });
    yield* service.create({ squadronId, launch: launchInput });
    assert.equal(registrations.length, 2);
    assert.deepStrictEqual(registrations[0], registrations[1]);
  }).pipe(
    Effect.provide(
      makeLayer({
        references: [projectId],
        register: (registration) =>
          Effect.sync(() => {
            // Capture the registrar inputs without changing the test's service graph.
            registrations.push(registration);
            return {
              squadronId,
              participantId: ParticipantId.make(`agent:${threadId}`),
            };
          }),
      }),
    ),
  );
});
