import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import {
  A2AHomeNotFoundError,
  A2AHomeRegistrar,
  layer as homeRegistrarLayer,
} from "./HomeRegistrar.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import {
  SquadronThreadCreationAmbiguousProjectError,
  SquadronThreadCreationProjectReferenceError,
  SquadronThreadCreationProjectUnavailableError,
  SquadronThreadCreationService,
  layer as squadronThreadCreationServiceLayer,
} from "./SquadronThreadCreationService.ts";
import {
  SquadronProjectReferences,
  layer as squadronProjectReferencesLayer,
} from "./SquadronProjectReferences.ts";
import { ParticipantId, SquadronId } from "./contracts.ts";

const squadronId = SquadronId.make("squadron:creation");
const projectId = ProjectId.make("project:creation");
const otherProjectId = ProjectId.make("project:other");
const threadId = ThreadId.make("thread:creation");
const commandId = CommandId.make("command:creation");
const createdAt = "2026-08-29T20:00:00.000Z";

const input = {
  squadronId,
  commandId,
  threadId,
  projectId,
  createdAt,
};

const makeLayer = (input: {
  readonly references: ReadonlyArray<ProjectId>;
  readonly register?: A2AHomeRegistrar["Service"]["registerAtCreation"];
  readonly getHomeForThread?: A2AHomeRegistrar["Service"]["getHomeForThread"];
}) => {
  const references = Layer.mock(SquadronProjectReferences)({
    listForSquadron: () =>
      Effect.succeed(
        input.references.map((candidateProjectId, ordinal) => ({
          squadronId,
          projectId: candidateProjectId,
          ordinal,
          createdAt,
        })),
      ),
  });
  const registrar = Layer.mock(A2AHomeRegistrar)({
    registerAtCreation:
      input.register ??
      (() =>
        Effect.succeed({
          squadronId,
          participantId: ParticipantId.make(`agent:${threadId}`),
        })),
    // A thread being launched has no home until this service registers one.
    getHomeForThread:
      input.getHomeForThread ?? ((threadId) => Effect.fail(new A2AHomeNotFoundError({ threadId }))),
  });
  return squadronThreadCreationServiceLayer.pipe(
    Layer.provideMerge(references),
    Layer.provideMerge(registrar),
    Layer.provide(Layer.mock(A2ALedger)({})),
    Layer.provide(Layer.mock(ProjectionProjectRepository)({})),
    Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
  );
};

it.effect("preserves a missing parent Registrar home as explicit native legacy state", () =>
  Effect.gen(function* () {
    const service = yield* SquadronThreadCreationService;
    const home = yield* service.findRegisteredHome(threadId);
    assert.isNull(home);
  }).pipe(
    Effect.provide(
      makeLayer({
        references: [projectId],
        getHomeForThread: () => Effect.fail(new A2AHomeNotFoundError({ threadId })),
      }),
    ),
  ),
);

it.effect("refuses unreferenced and ambiguous project selections without inference", () =>
  Effect.gen(function* () {
    const service = yield* SquadronThreadCreationService;
    const error = yield* service
      .registerAtDurableLaunch({ ...input, projectId: otherProjectId })
      .pipe(Effect.flip);
    assert.instanceOf(error, SquadronThreadCreationProjectReferenceError);
    assert.deepStrictEqual(error.referencedProjectIds, [projectId]);
  }).pipe(Effect.provide(makeLayer({ references: [projectId] }))),
);

it.effect("registers a launch once and returns that home on a replay without joining again", () => {
  const registrations: Array<Parameters<A2AHomeRegistrar["Service"]["registerAtCreation"]>[0]> = [];
  const home = { squadronId, participantId: ParticipantId.make(`agent:${threadId}`) };
  return Effect.gen(function* () {
    const service = yield* SquadronThreadCreationService;
    assert.deepStrictEqual(yield* service.registerAtDurableLaunch(input), home);
    assert.deepStrictEqual(yield* service.registerAtDurableLaunch(input), home);
    assert.deepStrictEqual(registrations, [
      {
        squadronId,
        threadId,
        createdAt,
        commandId: "command:j5:a2a:thread-creation:command%3Acreation",
      },
    ]);
  }).pipe(
    Effect.provide(
      makeLayer({
        references: [projectId],
        register: (registration) => {
          registrations.push(registration);
          return Effect.succeed(home);
        },
        getHomeForThread: (threadId) =>
          registrations.length > 0
            ? Effect.succeed(home)
            : Effect.fail(new A2AHomeNotFoundError({ threadId })),
      }),
    ),
  );
});

it.effect(
  "keeps a home a J5 spawn already recorded, without the one-project guard or a second join",
  () => {
    const registrations: Array<unknown> = [];
    const home = { squadronId, participantId: ParticipantId.make(`agent:${threadId}`) };
    return Effect.gen(function* () {
      const service = yield* SquadronThreadCreationService;
      // This Squadron references two projects, which would refuse creating a new home here.
      assert.deepStrictEqual(yield* service.registerAtDurableLaunch(input), home);
      assert.lengthOf(registrations, 0);
      const conflict = yield* service
        .registerAtDurableLaunch({ ...input, squadronId: "squadron:elsewhere" })
        .pipe(Effect.flip);
      assert.equal(conflict._tag, "A2AHomeConflictError");
      assert.lengthOf(registrations, 0);
    }).pipe(
      Effect.provide(
        makeLayer({
          references: [projectId, otherProjectId],
          register: (registration) => {
            registrations.push(registration);
            return Effect.succeed(home);
          },
          getHomeForThread: () => Effect.succeed(home),
        }),
      ),
    );
  },
);

/**
 * The launches below send no Squadron, so they run against the real ledger,
 * references and Registrar. Only the project lookup is a stand-in.
 */
const makeProjectRuleLayer = (
  projectTitles: Readonly<Record<string, string>> | "stored-projects",
  options: { readonly deleted?: boolean } = {},
) => {
  const database = NodeSqliteClient.layer({ filename: ":memory:" });
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const references = squadronProjectReferencesLayer.pipe(Layer.provide(database));
  const registrar = homeRegistrarLayer.pipe(Layer.provide(ledger), Layer.provide(database));
  const projects =
    projectTitles === "stored-projects"
      ? ProjectionProjectRepositoryLive.pipe(Layer.provide(database))
      : Layer.mock(ProjectionProjectRepository)({
          getById: ({ projectId: id }) =>
            // Yield so concurrent launches really interleave before they create.
            Effect.yieldNow.pipe(
              Effect.as(
                projectTitles[id] === undefined
                  ? Option.none()
                  : Option.some({
                      projectId: id,
                      title: projectTitles[id],
                      deletedAt: options.deleted === true ? createdAt : null,
                    } as never),
              ),
            ),
        });
  const creation = squadronThreadCreationServiceLayer.pipe(
    Layer.provide(registrar),
    Layer.provide(references),
    Layer.provide(ledger),
    Layer.provide(projects),
    Layer.provide(database),
  );
  return Layer.mergeAll(database, ledger, references, registrar, projects, creation);
};

const launchWithoutSquadron = (name: string, launchProjectId: ProjectId = projectId) => ({
  commandId: CommandId.make(`command:${name}`),
  threadId: ThreadId.make(`thread:${name}`),
  projectId: launchProjectId,
  createdAt,
});

const createSquadronForProject = Effect.fn(function* (
  name: string,
  referencedProjectId: ProjectId = projectId,
) {
  const ledger = yield* A2ALedger;
  const references = yield* SquadronProjectReferences;
  const id = SquadronId.make(`squadron:${name}`);
  yield* ledger.createSquadron({ squadron: { id, name, createdAt } });
  yield* references.replaceForSquadron({
    squadronId: id,
    projectIds: [referencedProjectId],
    createdAt,
  });
  return id;
});

const squadronsForProject = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly id: string; readonly name: string }>`
    SELECT squadron.id, squadron.name
    FROM j5_a2a_squadron_project_reference AS reference
    JOIN j5_a2a_squadron AS squadron ON squadron.id = reference.squadron_id
    WHERE reference.project_id = ${projectId}
  `;
});

it.effect("registers a launch without a Squadron into the one Squadron of its project", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const existing = yield* createSquadronForProject("only");
    yield* createSquadronForProject("elsewhere", otherProjectId);
    const service = yield* SquadronThreadCreationService;

    const home = yield* service.registerAtDurableLaunch(launchWithoutSquadron("one"));

    assert.equal(home.squadronId, existing);
    assert.deepStrictEqual(yield* service.findRegisteredHome(ThreadId.make("thread:one")), home);
    assert.lengthOf(yield* squadronsForProject, 1);
  }).pipe(Effect.provide(makeProjectRuleLayer({ [projectId]: "Alpha" }))),
);

it.effect("creates a Squadron named after the project when none exists, then reuses it", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const service = yield* SquadronThreadCreationService;

    const first = yield* service.registerAtDurableLaunch(launchWithoutSquadron("none:first"));
    const second = yield* service.registerAtDurableLaunch(launchWithoutSquadron("none:second"));

    assert.equal(second.squadronId, first.squadronId);
    assert.notEqual(second.participantId, first.participantId);
    assert.deepStrictEqual(yield* squadronsForProject, [{ id: first.squadronId, name: "Alpha" }]);
  }).pipe(Effect.provide(makeProjectRuleLayer({ [projectId]: "Alpha" }))),
);

it.effect("refuses a launch without a Squadron when several reference its project", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const first = yield* createSquadronForProject("several:first");
    const second = yield* createSquadronForProject("several:second");
    const service = yield* SquadronThreadCreationService;

    const error = yield* service
      .registerAtDurableLaunch(launchWithoutSquadron("several"))
      .pipe(Effect.flip);

    assert.instanceOf(error, SquadronThreadCreationAmbiguousProjectError);
    assert.sameMembers([...error.squadronIds], [first, second]);
    assert.isNull(yield* service.findRegisteredHome(ThreadId.make("thread:several")));
    assert.lengthOf(yield* squadronsForProject, 2);
  }).pipe(Effect.provide(makeProjectRuleLayer({ [projectId]: "Alpha" }))),
);

it.effect("honors a sent Squadron over the project rule", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    yield* createSquadronForProject("explicit:first");
    const chosen = yield* createSquadronForProject("explicit:chosen");
    const service = yield* SquadronThreadCreationService;

    const home = yield* service.registerAtDurableLaunch({
      ...launchWithoutSquadron("explicit"),
      squadronId: chosen,
    });

    assert.equal(home.squadronId, chosen);
    assert.lengthOf(yield* squadronsForProject, 2);
  }).pipe(Effect.provide(makeProjectRuleLayer({ [projectId]: "Alpha" }))),
);

it.effect("creates one Squadron for two concurrent launches into a project with none", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const service = yield* SquadronThreadCreationService;

    const [left, right] = yield* Effect.all(
      [
        service.registerAtDurableLaunch(launchWithoutSquadron("concurrent:left")),
        service.registerAtDurableLaunch(launchWithoutSquadron("concurrent:right")),
      ],
      { concurrency: "unbounded" },
    );

    assert.equal(left.squadronId, right.squadronId);
    assert.deepStrictEqual(yield* squadronsForProject, [{ id: left.squadronId, name: "Alpha" }]);
    const ledger = yield* A2ALedger;
    assert.lengthOf(yield* ledger.listSquadrons(), 1);
    assert.sameMembers(
      (yield* ledger.listMembership(left.squadronId)).map((member) => member.participant.id),
      [left.participantId, right.participantId],
    );
  }).pipe(Effect.provide(makeProjectRuleLayer({ [projectId]: "Alpha" }))),
);

it.effect("replays into the registered home after the project gains a second Squadron", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const service = yield* SquadronThreadCreationService;
    const launch = launchWithoutSquadron("replay");

    const first = yield* service.registerAtDurableLaunch(launch);
    yield* createSquadronForProject("replay:later");
    const replayed = yield* service.registerAtDurableLaunch(launch);

    assert.deepStrictEqual(replayed, first);
    const ledger = yield* A2ALedger;
    assert.lengthOf(yield* ledger.listMembership(first.squadronId), 1);
  }).pipe(Effect.provide(makeProjectRuleLayer({ [projectId]: "Alpha" }))),
);

const refusesUnavailableProject = Effect.gen(function* () {
  yield* runJ5A2AMigrations();
  const service = yield* SquadronThreadCreationService;

  const error = yield* service
    .registerAtDurableLaunch(launchWithoutSquadron("unavailable"))
    .pipe(Effect.flip);

  assert.instanceOf(error, SquadronThreadCreationProjectUnavailableError);
  const ledger = yield* A2ALedger;
  assert.lengthOf(yield* ledger.listSquadrons(), 0);
});

it.effect("creates no Squadron for a project that is missing", () =>
  refusesUnavailableProject.pipe(Effect.provide(makeProjectRuleLayer({}))),
);

it.effect("registers nothing in the one Squadron of a deleted project", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const existing = yield* createSquadronForProject("deleted-project");
    const service = yield* SquadronThreadCreationService;

    const error = yield* service
      .registerAtDurableLaunch(launchWithoutSquadron("deleted-project"))
      .pipe(Effect.flip);

    assert.instanceOf(error, SquadronThreadCreationProjectUnavailableError);
    const ledger = yield* A2ALedger;
    assert.lengthOf(yield* ledger.listMembership(existing), 0);
  }).pipe(Effect.provide(makeProjectRuleLayer({ [projectId]: "Alpha" }, { deleted: true }))),
);

it.effect("creates no Squadron for a deleted project", () =>
  refusesUnavailableProject.pipe(
    Effect.provide(makeProjectRuleLayer({ [projectId]: "Alpha" }, { deleted: true })),
  ),
);

it.effect("reads the project's stored title and deletion from the projection", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    yield* runJ5A2AMigrations();
    const projects = yield* ProjectionProjectRepository;
    const storedProject = (id: ProjectId, title: string, deletedAt: string | null) =>
      projects.upsert({
        projectId: id,
        title,
        workspaceRoot: `/tmp/${title}`,
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        autoPull: false,
        scripts: [],
        createdAt: createdAt as never,
        updatedAt: createdAt as never,
        deletedAt: deletedAt as never,
      });
    yield* storedProject(projectId, "Stored title", null);
    yield* storedProject(otherProjectId, "Deleted", createdAt);
    const service = yield* SquadronThreadCreationService;

    const home = yield* service.registerAtDurableLaunch(launchWithoutSquadron("stored"));
    const error = yield* service
      .registerAtDurableLaunch(launchWithoutSquadron("stored:deleted", otherProjectId))
      .pipe(Effect.flip);

    assert.deepStrictEqual(yield* squadronsForProject, [
      { id: home.squadronId, name: "Stored title" },
    ]);
    assert.instanceOf(error, SquadronThreadCreationProjectUnavailableError);
  }).pipe(Effect.provide(makeProjectRuleLayer("stored-projects"))),
);
