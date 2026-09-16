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
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  AgentCrewInstanceService,
  layer as crewInstanceLayer,
} from "./AgentCrewInstanceService.ts";
import { CrewLaunchService, layer as crewLaunchLayer } from "./CrewLaunchService.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
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
) =>
  Layer.mergeAll(
    Layer.mock(ThreadManagementService)({
      getThreadProjection: (threadId) =>
        Effect.succeed({ thread: thread(threadId) } as unknown as OrchestrationV2ThreadProjection),
      dispatch: (command) =>
        Ref.update(commands, (items) => [...items, command]).pipe(
          Effect.as({ events: [], effects: [] } as never),
        ),
    }),
    Layer.mock(SpawnCompositionService)({
      recordFacts: (input) =>
        Effect.succeed({
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
