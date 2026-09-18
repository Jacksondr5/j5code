import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { ServerConfig } from "../../config.ts";
import { OrchestratorProjectionError } from "../../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreReadError } from "../../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  AgentCrewInstanceService,
  layer as crewInstanceLayer,
} from "./AgentCrewInstanceService.ts";
import { CrewLaunchService, layer as crewLaunchLayer } from "./CrewLaunchService.ts";
import { A2AHomeConflictError, participantIdForThread } from "./HomeRegistrar.ts";
import { crewSeatRequestKey, spawnCrewInstanceId, spawnThreadId } from "./spawnIds.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { SpawnCompositionService } from "./SpawnCompositionService.ts";
import { ParticipantId, SquadronId } from "./contracts.ts";

const squadronId = SquadronId.make("squadron:crew-launch");
const captainThread = ThreadId.make("thread:captain");
const captainId = ParticipantId.make("agent:captain");
const createdAt = DateTime.makeUnsafe("2026-09-09T16:00:00.000Z");

const provider = (
  instanceId: string,
  driver: string,
  models: ReadonlyArray<{ slug: string; options: ReadonlyArray<string> }>,
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-09T00:00:00Z",
  availability: "available",
  slashCommands: [],
  skills: [],
  models: models.map((model) => ({
    slug: model.slug,
    name: model.slug,
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: driver === "codex" ? "reasoningEffort" : "effort",
          label: "Reasoning",
          type: "select",
          options: model.options.map((id) => ({ id, label: id })),
        },
      ],
    },
  })),
});

const thread = (id: ThreadId): OrchestrationV2AppThread =>
  ({
    id,
    projectId: ProjectId.make("project:crew-launch"),
    title: `Thread ${id}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: "/repo",
    createdAt,
    archivedAt: null,
  }) as unknown as OrchestrationV2AppThread;

const fixture = Effect.gen(function* () {
  const database = NodeSqliteClient.layerMemory();
  const storage = Layer.mergeAll(ledgerLayer, crewInstanceLayer).pipe(Layer.provideMerge(database));
  const context = yield* Layer.build(storage);
  yield* runJ5A2AMigrations().pipe(Effect.provide(context));
  yield* Effect.provide(
    Effect.gen(function* () {
      yield* (yield* A2ALedger).createSquadron({
        squadron: {
          id: squadronId,
          name: "Launch Squadron",
          createdAt: DateTime.formatIso(createdAt),
        },
      });
    }),
    context,
  );
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2Command>>([]);
  const captain = {
    squadronId,
    squadronName: "Launch Squadron",
    participantId: captainId,
    thread: thread(captainThread),
  };
  return { context, commands, captain };
});

const dependencies = (
  commands: Ref.Ref<ReadonlyArray<OrchestrationV2Command>>,
  providers: ReadonlyArray<ServerProvider>,
  /** Seat threads whose first home registration fails, to leave a launch half done. */
  failHomeOnce: Set<string> = new Set(),
  /** Seat threads whose projection the store cannot read, once; a not-found is not among them. */
  unreadableOnce: Set<string> = new Set(),
) =>
  Layer.mergeAll(
    Layer.mock(ThreadManagementService)({
      getThreadProjection: (threadId) =>
        unreadableOnce.delete(threadId)
          ? Effect.fail(
              new OrchestratorProjectionError({
                threadId,
                cause: new ProjectionStoreReadError({ threadId }),
              }),
            )
          : Effect.succeed({
              thread: thread(threadId),
            } as unknown as OrchestrationV2ThreadProjection),
      dispatch: (command) =>
        Ref.update(commands, (items) => [...items, command]).pipe(
          Effect.as({ events: [], effects: [] } as never),
        ),
    }),
    Layer.mock(SpawnCompositionService)({
      recordFacts: (input) =>
        failHomeOnce.delete(input.threadId)
          ? Effect.fail(
              new A2AHomeConflictError({
                threadId: input.threadId,
                existingSquadronId: "squadron:elsewhere",
                requestedSquadronId: input.squadronId,
              }),
            )
          : Effect.succeed({
              home: { squadronId, participantId: participantIdForThread(input.threadId) },
              placement: {
                squadronId,
                participantId: participantIdForThread(input.threadId),
                provenance: {
                  kind: "spawned-by" as const,
                  spawnedByParticipantId: input.spawnedByParticipantId,
                  source: "j5_spawn" as const,
                },
                placementParentId: input.spawnedByParticipantId,
                createdEventSeq: 1,
                updatedEventSeq: 1,
              },
            }),
    }),
    Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
  );

it.effect("launches an approved roster whole, records it, briefs each seat, then adds a seat", () =>
  Effect.gen(function* () {
    const { context, commands, captain } = yield* fixture;
    const codex = provider("codex", "codex", [
      { slug: "gpt-5.6-sol", options: ["high"] },
      { slug: "gpt-5.6-terra", options: ["high"] },
    ]);
    const layer = crewLaunchLayer.pipe(
      Layer.provideMerge(dependencies(commands, [codex])),
      Layer.provideMerge(Layer.succeedContext(context)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "j5-crew-launch-" })),
      Layer.provideMerge(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const launcher = yield* CrewLaunchService;
      const crews = yield* AgentCrewInstanceService;

      // Publisher has no enforceable provider, so a roster containing it launches nothing.
      const refused = yield* launcher
        .launch({
          providerSessionId: "session",
          requestKey: "launch-1",
          captain,
          displayName: "Release Crew",
          seats: [
            { name: "builder", agentId: "builder", reason: "Implements" },
            { name: "publisher", agentId: "publisher", reason: "Publishes" },
          ],
          brief: "Ship the login fix.",
        })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "CrewLaunchSeatUnavailableError");
      assert.lengthOf(yield* Ref.get(commands), 0);

      const instance = yield* launcher.launch({
        providerSessionId: "session",
        requestKey: "launch-1",
        captain,
        displayName: "Review Pair",
        seats: [
          {
            name: "builder",
            agentId: "builder",
            reason: "Implements",
            instructions: "Send code to critic.",
          },
          { name: "critic", agentId: "critic", reason: "Reviews" },
        ],
        brief: "Ship the login fix.",
      });
      assert.equal(instance.version, 1);
      assert.equal(instance.captainThreadId, captainThread);
      assert.deepStrictEqual(
        instance.members.map((member) => [member.seatName, member.addedVersion]),
        [
          ["builder", 1],
          ["critic", 1],
        ],
      );
      const captured = yield* Ref.get(commands);
      assert.deepStrictEqual(
        captured.map((command) => command.type),
        ["thread.create", "thread.create", "message.dispatch", "message.dispatch"],
      );
      const builderBrief = captured[2];
      if (builderBrief?.type === "message.dispatch") {
        assert.include(builderBrief.text, "your_seat: builder");
        assert.include(builderBrief.text, `captain_participant_id: ${captainId}`);
        assert.include(builderBrief.text, "- critic: participant_id=");
        assert.include(builderBrief.text, "<seat_instructions>\nSend code to critic.");
        assert.include(builderBrief.text, "<spawner_brief>\nShip the login fix.");
      }
      assert.isNotNull(yield* crews.findMembership(instance.members[1]!.participantId));

      const grown = yield* launcher.addSeats({
        providerSessionId: "session",
        requestKey: "add-1",
        captain,
        instance,
        seats: [{ name: "sentry", agentId: "sentry", reason: "Security pass" }],
      });
      assert.equal(grown.version, 2);
      assert.deepStrictEqual(
        grown.members.map((member) => [member.seatName, member.addedVersion]),
        [
          ["builder", 1],
          ["critic", 1],
          ["sentry", 2],
        ],
      );
      const sentryBrief = (yield* Ref.get(commands)).at(-1);
      if (sentryBrief?.type === "message.dispatch") {
        assert.include(sentryBrief.text, "your_seat: sentry");
        assert.include(sentryBrief.text, "- builder: participant_id=");
        assert.include(sentryBrief.text, "<spawner_brief>\nShip the login fix.");
      }
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect(
  "a retry after the person renamed a seat retires the seat the failed launch created",
  () =>
    Effect.gen(function* () {
      const { context, commands, captain } = yield* fixture;
      const codex = provider("codex", "codex", [
        { slug: "gpt-5.6-sol", options: ["high"] },
        { slug: "gpt-5.6-terra", options: ["high"] },
      ]);
      const seatThread = (seat: string) =>
        spawnThreadId({
          providerSessionId: "session",
          requestKey: crewSeatRequestKey("retry-1", seat),
        });
      // Filled after the first launch, so the failed spawn's own read of the created thread
      // still succeeds and only the retry's read of the earlier seat is refused.
      const unreadable = new Set<string>();
      const layer = crewLaunchLayer.pipe(
        Layer.provideMerge(
          dependencies(commands, [codex], new Set([seatThread("critic")]), unreadable),
        ),
        Layer.provideMerge(Layer.succeedContext(context)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "j5-crew-launch-" })),
        Layer.provideMerge(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const launcher = yield* CrewLaunchService;
        const crews = yield* AgentCrewInstanceService;
        const seats = (second: string) => [
          { name: "builder", agentId: "builder", reason: "Implements" },
          { name: second, agentId: "critic", reason: "Reviews" },
        ];
        const launch = (second: string) =>
          launcher.launch({
            providerSessionId: "session",
            requestKey: "retry-1",
            captain,
            displayName: "Review Pair",
            seats: seats(second),
            brief: "Ship the login fix.",
          });
        // The critic's thread is created, then its home registration fails: the record names both
        // seats and the critic has a thread with no brief.
        const failed = yield* launch("critic").pipe(Effect.flip);
        assert.equal(failed._tag, "CrewLaunchOperationError");
        const crewId = spawnCrewInstanceId({ providerSessionId: "session", requestKey: "retry-1" });
        assert.sameMembers(
          (yield* crews.read(crewId))!.members.map(({ seatName }) => seatName),
          ["builder", "critic"],
        );
        assert.include(
          (yield* Ref.get(commands))
            .filter((command) => command.type === "thread.create")
            .map((command) => command.threadId),
          seatThread("critic"),
        );

        // The person renames the seat on the card and approves again. The first retry cannot
        // read the critic's thread: it fails rather than dropping the row from under a thread
        // that may be live, and the record still names the critic.
        unreadable.add(seatThread("critic"));
        const refused = yield* launch("reviewer").pipe(Effect.flip);
        assert.equal(refused._tag, "CrewLaunchOperationError");
        assert.include(refused.message, "reading the earlier seat critic");
        assert.sameMembers(
          (yield* crews.read(crewId))!.members.map(({ seatName }) => seatName),
          ["builder", "critic"],
        );
        const instance = yield* launch("reviewer");
        assert.deepStrictEqual(
          instance.members.map(({ seatName }) => seatName),
          ["builder", "reviewer"],
        );
        const archived = (yield* Ref.get(commands))
          .filter((command) => command.type === "thread.archive")
          .map((command) => command.threadId);
        assert.deepStrictEqual(archived, [seatThread("critic")]);
        assert.isNull(yield* crews.findMembership(participantIdForThread(seatThread("critic"))));
        // Every seat that launches was briefed, and the roster in the brief is the one that launched.
        const briefs = (yield* Ref.get(commands)).filter(
          (command) => command.type === "message.dispatch",
        );
        assert.lengthOf(briefs, 2);
        const reviewerBrief = briefs.at(-1);
        if (reviewerBrief?.type === "message.dispatch") {
          assert.include(reviewerBrief.text, "your_seat: reviewer");
          assert.notInclude(reviewerBrief.text, "- critic:");
        }
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect(
  "a seat whose provider is signed out is refused at spawn, before anything is created",
  () =>
    Effect.gen(function* () {
      const { context, commands, captain } = yield* fixture;
      const signedOut = {
        ...provider("codex", "codex", [{ slug: "gpt-5.6-sol", options: ["high"] }]),
        auth: { status: "unauthenticated" as const },
      };
      const layer = crewLaunchLayer.pipe(
        Layer.provideMerge(dependencies(commands, [signedOut])),
        Layer.provideMerge(Layer.succeedContext(context)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "j5-crew-launch-" })),
        Layer.provideMerge(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const launcher = yield* CrewLaunchService;
        const refused = yield* launcher
          .launch({
            providerSessionId: "session",
            requestKey: "signed-out-1",
            captain,
            displayName: "Signed Out",
            seats: [{ name: "builder", agentId: "builder", reason: "Implements" }],
            brief: "Ship it.",
          })
          .pipe(Effect.flip);
        assert.equal(refused._tag, "CrewLaunchSeatUnavailableError");
        assert.include(refused.message, "signed out");
        assert.lengthOf(yield* Ref.get(commands), 0);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);
