import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";

import { makeAgentPersonaLibrary } from "../agents/agentPersonaLibrary.ts";
import { resolveAgentPersonaRuntime } from "../agents/agentPersonaRuntime.ts";
import { guardAgentPersonaThreadCreate } from "../agents/agentPersonaOrchestration.ts";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  OrchestratorDispatchError,
  OrchestratorProjectionError,
} from "../../orchestration-v2/Orchestrator.ts";
import {
  ProjectionStoreReadError,
  ProjectionStoreThreadNotFoundError,
} from "../../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  AgentCrewInstanceService,
  layer as crewInstanceLayer,
  type AgentCrewInstance,
} from "./AgentCrewInstanceService.ts";
import { ArchiveAgentService } from "./ArchiveAgentService.ts";
import { ArchiveCrewService, layer as archiveCrewLayer } from "./ArchiveCrewService.ts";
import { describeCrewSeatRuntime } from "./crewRuntimePreview.ts";
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
  const database = NodeSqliteClient.layer({ filename: ":memory:" });
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
  archived: Set<string> = new Set(),
  realThreads = false,
  failBriefOnce: Set<string> = new Set(),
  /** Runs before each command lands, so a test can hold a spawn open. */
  beforeDispatch: (
    command: OrchestrationV2Command,
  ) => Effect.Effect<void, OrchestratorDispatchError> = () => Effect.void,
) =>
  Layer.mergeAll(
    Layer.mock(ThreadManagementService)({
      getThreadProjection: (threadId) =>
        realThreads
          ? Ref.get(commands).pipe(
              Effect.flatMap((commands) => {
                const created = commands.find(
                  (command) => command.type === "thread.create" && command.threadId === threadId,
                );
                return created?.type === "thread.create"
                  ? Effect.succeed({
                      thread: { ...thread(threadId), ...created },
                      messages: commands.flatMap((command) =>
                        command.type === "message.dispatch" && command.threadId === threadId
                          ? [{ id: command.messageId, text: command.text }]
                          : [],
                      ),
                    } as unknown as OrchestrationV2ThreadProjection)
                  : Effect.fail(
                      new OrchestratorProjectionError({
                        threadId,
                        cause: new ProjectionStoreThreadNotFoundError({ threadId }),
                      }),
                    );
              }),
            )
          : unreadableOnce.delete(threadId)
            ? Effect.fail(
                new OrchestratorProjectionError({
                  threadId,
                  cause: new ProjectionStoreReadError({ threadId }),
                }),
              )
            : Effect.succeed({
                messages: [],
                thread: {
                  ...thread(threadId),
                  archivedAt: archived.has(threadId) ? createdAt : null,
                },
              } as unknown as OrchestrationV2ThreadProjection),
      dispatch: (command) =>
        Effect.gen(function* () {
          yield* beforeDispatch(command);
          if (command.type === "message.dispatch" && failBriefOnce.delete(command.threadId))
            return yield* new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
            });
          yield* Ref.update(commands, (items) => {
            if (command.type === "thread.archive") archived.add(command.threadId);
            return [...items, command];
          });
          return { events: [], effects: [] } as never;
        }),
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
                provenance: input.provenance,
                placementParentId:
                  input.provenance.kind === "spawned-by"
                    ? input.provenance.spawnedByParticipantId
                    : null,
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
        const beforeRetry = (yield* Ref.get(commands)).length;
        const retiredSeat = yield* launch("critic").pipe(Effect.flip);
        assert.equal(retiredSeat._tag, "CrewLaunchOperationError");
        assert.include(retiredSeat.message, "reusing a retired seat");
        assert.equal((yield* Ref.get(commands)).length, beforeRetry);
        assert.sameMembers(
          (yield* crews.read(crewId))!.members.map((member) => member.seatName),
          ["builder", "reviewer"],
        );
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
  "a custom seat runs on the Captain's model and access with no saved agent behind it",
  () =>
    Effect.gen(function* () {
      const { context, commands, captain } = yield* fixture;
      const codex = provider("codex", "codex", [
        { slug: "gpt-5.6-sol", options: ["high"] },
        { slug: "gpt-5.6-terra", options: ["high"] },
      ]);
      const layer = crewLaunchLayer.pipe(
        Layer.provideMerge(dependencies(commands, [codex])),
        Layer.provideMerge(Layer.succeedContext(context)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "j5-crew-custom-" })),
        Layer.provideMerge(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const launcher = yield* CrewLaunchService;
        const instance = yield* launcher.launch({
          providerSessionId: "session",
          requestKey: "launch-custom",
          captain,
          displayName: "Notes Crew",
          seats: [
            { name: "critic", agentId: "critic", reason: "Reviews" },
            {
              name: "scribe",
              agentId: null,
              reason: "Keeps notes",
              instructions: "Write the running notes.",
            },
          ],
          brief: "Review the login fix.",
        });
        assert.deepStrictEqual(
          instance.members.map((member) => [member.seatName, member.agentId]),
          [
            ["critic", "critic"],
            ["scribe", null],
          ],
        );
        const captured = yield* Ref.get(commands);
        const created = captured.find(
          (command) => command.type === "thread.create" && command.title === "scribe",
        );
        assert.equal(created?.type, "thread.create");
        if (created?.type === "thread.create") {
          // No definition to run as: the Captain's own route and access, and no persona assignment.
          assert.isUndefined(created.agentPersonaAssignment);
          assert.deepStrictEqual(created.modelSelection, captain.thread.modelSelection);
          assert.equal(created.runtimeMode, captain.thread.runtimeMode);
        }
        const brief = captured.find(
          (command) =>
            command.type === "message.dispatch" && command.text.includes("your_seat: scribe"),
        );
        assert.equal(brief?.type, "message.dispatch");
        if (brief?.type === "message.dispatch") {
          assert.include(brief.text, "<seat_instructions>\nWrite the running notes.");
          assert.notInclude(brief.text, "<seat_obligation>");
          assert.include(brief.text, "persona=custom");
        }

        // A persona Captain stores the mode the person picked at launch (full-access here) but runs
        // under its persona's policy; its custom seat takes that effective access, not the stored mode.
        const personaCaptain = {
          ...captain,
          thread: {
            ...captain.thread,
            agentPersonaAssignment: {
              personaId: "builder",
              definitionVersion: 1,
              authorityPolicy: "workspace-write",
              resolvedRoute: "primary",
              resolvedDriver: "codex",
              resolvedModelSelection: captain.thread.modelSelection,
            },
          } as typeof captain.thread,
        };
        yield* launcher.launch({
          providerSessionId: "session",
          requestKey: "launch-custom-2",
          captain: personaCaptain,
          displayName: "Notes Crew 2",
          seats: [{ name: "scribe", agentId: null, reason: "Keeps notes", instructions: "Notes." }],
          brief: "Review the login fix.",
        });
        const underPersona = (yield* Ref.get(commands)).findLast(
          (command) => command.type === "thread.create" && command.title === "scribe",
        );
        assert.equal(underPersona?.type, "thread.create");
        if (underPersona?.type === "thread.create") {
          assert.equal(captain.thread.runtimeMode, "full-access");
          assert.equal(underPersona.runtimeMode, "auto-accept-edits");
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

it.effect("custom seats refuse unavailable providers before recording or spawning", () =>
  Effect.gen(function* () {
    const { context, commands, captain } = yield* fixture;
    const available = provider("codex", "codex", [{ slug: "gpt-5.6-sol", options: ["high"] }]);
    for (const providers of [
      [],
      [{ ...available, auth: { status: "unauthenticated" as const } }],
      [{ ...available, enabled: false }],
      [{ ...available, models: [] }],
    ]) {
      const testLayer = crewLaunchLayer.pipe(
        Layer.provideMerge(dependencies(commands, providers)),
        Layer.provideMerge(Layer.succeedContext(context)),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "j5-custom-unavailable-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const launcher = yield* CrewLaunchService;
        const error = yield* launcher
          .launch({
            providerSessionId: "session",
            requestKey: "unavailable-custom",
            captain,
            displayName: "Notes",
            seats: [
              { name: "scribe", agentId: null, reason: "Notes", instructions: "Take notes." },
            ],
            brief: "Review.",
          })
          .pipe(Effect.flip);
        assert.equal(error._tag, "CrewLaunchSeatUnavailableError");
        assert.lengthOf(yield* Ref.get(commands), 0);
        assert.lengthOf(yield* (yield* AgentCrewInstanceService).listLive(), 0);
      }).pipe(Effect.provide(testLayer));
    }
  }).pipe(Effect.scoped),
);

it.effect(
  "previews actual routes and pins custom defaults; approved launches and retries keep that exact runtime",
  () =>
    Effect.gen(function* () {
      const { context, commands, captain } = yield* fixture;
      const codex = provider("codex", "codex", [{ slug: "gpt-5.6-sol", options: ["high", "low"] }]);
      const withDefaults: ServerProvider = {
        ...codex,
        displayName: "Codex",
        models: codex.models.map((model) => ({
          ...model,
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                label: "Reasoning",
                type: "select",
                currentValue: "high",
                options: [
                  { id: "high", label: "High" },
                  { id: "low", label: "Low" },
                ],
              },
            ],
          },
        })),
      };
      const providers = [withDefaults];
      const layer = crewLaunchLayer.pipe(
        Layer.provideMerge(
          dependencies(commands, providers, new Set(), new Set(), new Set(), true),
        ),
        Layer.provideMerge(Layer.succeedContext(context)),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "j5-preview-runtime-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const launcher = yield* CrewLaunchService;
        const seats = [
          { name: "scribe", agentId: null, reason: "Notes", instructions: "Take notes" },
        ];
        const resolvedSeats = yield* launcher.resolveSeats(captain, seats);
        assert.deepStrictEqual(resolvedSeats[0]?.runtime, {
          seat: "scribe",
          provider: "OpenAI",
          harness: "Codex",
          model: "gpt-5.6-sol",
          reasoning: "High",
          access: "Full access",
          modelSelection: {
            ...captain.thread.modelSelection,
            options: [{ id: "reasoningEffort", value: "high" }],
          },
          runtimeMode: "full-access",
        });
        assert.deepStrictEqual(resolvedSeats[0]?.modelSelection.options, [
          { id: "reasoningEffort", value: "high" },
        ]);
        const input = {
          providerSessionId: "session",
          requestKey: "runtime-pinned",
          captain,
          displayName: "Notes",
          seats,
          resolvedSeats,
          brief: "Review",
        };
        // A changed provider default after validation cannot alter the approved launch.
        providers[0] = {
          ...withDefaults,
          models: withDefaults.models.map((model) => ({
            ...model,
            capabilities: {
              optionDescriptors: [
                {
                  id: "reasoningEffort",
                  label: "Reasoning",
                  type: "select",
                  currentValue: "low",
                  options: [
                    { id: "high", label: "High" },
                    { id: "low", label: "Low" },
                  ],
                },
              ],
            },
          })),
        };
        const launched = yield* launcher.launch(input);
        const create = (yield* Ref.get(commands)).find(
          (command) => command.type === "thread.create",
        );
        assert.equal(create?.type, "thread.create");
        if (create?.type === "thread.create")
          assert.deepStrictEqual(create.modelSelection, resolvedSeats[0]?.modelSelection);
        const retried = yield* launcher.launch(input);
        assert.equal(retried.id, launched.id);
        const changedSeats = yield* launcher.resolveSeats(captain, seats);
        assert.equal(changedSeats[0]?.runtime.reasoning, "Low");
        const before = (yield* Ref.get(commands)).length;
        const changed = yield* launcher
          .launch({ ...input, resolvedSeats: changedSeats })
          .pipe(Effect.flip);
        assert.equal(changed._tag, "CrewLaunchSeatUnavailableError");
        assert.lengthOf(yield* Ref.get(commands), before);
        const saved = yield* launcher.resolveSeats(captain, [
          { name: "builder", agentId: "builder", reason: "Build" },
        ]);
        assert.equal(saved[0]?.assignment?.resolvedDriver, "codex");
        assert.equal(saved[0]?.runtime.harness, "Codex");
        assert.equal(saved[0]?.runtime.access, "Repository write");
        const accessOnly = (yield* launcher.resolveSeats(captain, [
          { name: "builder", agentId: "builder", reason: "Build", runtimeMode: "full-access" },
        ]))[0]!;
        assert.deepStrictEqual(accessOnly.modelSelection, saved[0]?.modelSelection);
        assert.equal(accessOnly.assignment?.resolvedRoute, saved[0]?.assignment?.resolvedRoute);
        assert.equal(accessOnly.runtime.access, "Full access");
        const accessPolicy = yield* resolveAgentPersonaRuntime(
          {
            agentPersonaAssignment: accessOnly.assignment!,
            runtimeMode: accessOnly.runtimeMode,
          },
          yield* makeAgentPersonaLibrary,
        );
        assert.equal(accessPolicy.runtimeMode, "full-access");
        assert.notProperty(accessPolicy, "sandboxPolicy");

        assert.equal(
          saved[0]?.modelSelection.model,
          saved[0]?.assignment?.resolvedModelSelection.model,
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.each([
  ["codex", "Codex", undefined, "OpenAI", "Codex"],
  ["claudeAgent", "Claude", undefined, "Anthropic", "Claude Code"],
  ["claudeAgent", "Claude Code", undefined, "Anthropic", "Claude Code"],
  ["codex", "Work account", undefined, "OpenAI (Work account)", "Codex"],
  ["codex", "Codex", "Other vendor", "Other vendor", "Codex"],
  ["opencode", "Team account", "OpenAI", "OpenAI (Team account)", "OpenCode"],
])(
  "runtime provider label for %s / %s respects the model vendor and configured instance",
  (driver, displayName, subProvider, expectedProvider, expectedHarness) => {
    const configured = provider("instance", driver!, [{ slug: "model", options: ["high"] }]);
    const runtime = describeCrewSeatRuntime(
      "seat",
      { instanceId: configured.instanceId, model: "model" },
      {
        ...configured,
        displayName: displayName!,
        models: configured.models.map((model) => ({
          ...model,
          ...(subProvider === undefined ? {} : { subProvider }),
        })),
      },
      "full-access",
      null,
    );
    assert.equal(runtime.provider, expectedProvider);
    assert.equal(runtime.harness, expectedHarness);
  },
);

it.effect(
  "custom runtime overrides select the advertised harness, model, reasoning, and access without fallback",
  () =>
    Effect.gen(function* () {
      const { context, commands, captain } = yield* fixture;
      const providers = [
        provider("codex", "codex", [{ slug: "gpt-5.6-sol", options: ["high"] }]),
        provider("claude-work", "claudeAgent", [
          { slug: "claude-sonnet", options: ["high", "low"] },
        ]),
        provider("acp", "acpRegistry", [{ slug: "model", options: [] }]),
      ];
      const layer = crewLaunchLayer.pipe(
        Layer.provideMerge(
          dependencies(commands, providers, new Set(), new Set(), new Set(), true),
        ),
        Layer.provideMerge(Layer.succeedContext(context)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "j5-custom-runtime-" })),
        Layer.provideMerge(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const launcher = yield* CrewLaunchService;
        const custom = {
          name: "reviewer",
          agentId: null,
          reason: "Review",
          instructions: "Read changes",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claude-work"),
            model: "claude-sonnet",
            options: [{ id: "effort", value: "low" }],
          },
          runtimeMode: "approval-required" as const,
        };
        const resolvedSeats = yield* launcher.resolveSeats(captain, [custom]);
        const resolved = resolvedSeats[0]!;
        assert.deepStrictEqual(resolved.modelSelection, custom.modelSelection);
        assert.equal(resolved.runtimeMode, "approval-required");
        assert.equal(resolved.runtime.harness, "Claude Code");
        assert.equal(resolved.runtime.reasoning, "low");
        assert.equal(resolved.runtime.access, "Approval required");
        assert.deepStrictEqual(resolved.runtime.modelSelection, custom.modelSelection);
        assert.equal(resolved.runtime.runtimeMode, custom.runtimeMode);
        const instance = yield* launcher.launch({
          providerSessionId: "session",
          requestKey: "custom-override",
          captain,
          displayName: "Review",
          seats: [custom],
          resolvedSeats,
          brief: "Review",
        });
        const created = (yield* Ref.get(commands)).find(
          (command) => command.type === "thread.create",
        );
        assert.equal(created?.type, "thread.create");
        if (created?.type === "thread.create") {
          assert.deepStrictEqual(created.modelSelection, custom.modelSelection);
          assert.equal(created.runtimeMode, custom.runtimeMode);
          assert.isUndefined(created.agentPersonaAssignment);
        }
        const additional = { ...custom, name: "scribe", runtimeMode: "full-access" as const };
        const addedResolved = yield* launcher.resolveSeats(captain, [additional]);
        yield* launcher.addSeats({
          providerSessionId: "session",
          requestKey: "custom-override-add",
          captain,
          instance,
          seats: [additional],
          resolvedSeats: addedResolved,
        });
        const added = (yield* Ref.get(commands)).findLast(
          (command) => command.type === "thread.create",
        );
        if (added?.type === "thread.create") {
          assert.deepStrictEqual(added.modelSelection, additional.modelSelection);
          assert.equal(added.runtimeMode, "full-access");
        }
        for (const modelSelection of [
          { ...custom.modelSelection, instanceId: ProviderInstanceId.make("missing") },
          { ...custom.modelSelection, model: "missing" },
          { ...custom.modelSelection, options: [{ id: "effort", value: "unsupported" }] },
          { ...custom.modelSelection, options: [{ id: "effort", value: true }] },
          { ...custom.modelSelection, options: [{ id: "unknown", value: "high" }] },
          {
            ...custom.modelSelection,
            options: [
              { id: "effort", value: "low" },
              { id: "effort", value: "high" },
            ],
          },
        ]) {
          const invalid = yield* launcher
            .resolveSeats(captain, [{ ...custom, modelSelection }])
            .pipe(Effect.flip);
          assert.equal(invalid._tag, "CrewLaunchSeatUnavailableError");
        }
        const invalidAccess = yield* launcher
          .resolveSeats(captain, [
            {
              ...custom,
              modelSelection: { instanceId: ProviderInstanceId.make("acp"), model: "model" },
              runtimeMode: "auto-accept-edits",
            },
          ])
          .pipe(Effect.flip);
        assert.equal(invalidAccess._tag, "CrewLaunchSeatUnavailableError");
        assert.include(invalidAccess.message, "Choose Approval required or Full access");
        // Neither configured provider advertises Critic's saved model: the human override
        // still launches, preserving its snapshot and behavior on the selected harness.
        const personaSeat = {
          ...custom,
          name: "saved-reviewer",
          agentId: "critic",
          runtimeMode: "full-access" as const,
        };
        const personaOverride = yield* launcher.resolveSeats(captain, [personaSeat]);
        const saved = personaOverride[0]!;
        assert.equal(saved.assignment?.resolvedRoute, "override");
        assert.deepStrictEqual(saved.modelSelection, custom.modelSelection);
        assert.equal(saved.runtime.access, "Full access");
        const library = yield* makeAgentPersonaLibrary;
        const policy = yield* resolveAgentPersonaRuntime(
          { agentPersonaAssignment: saved.assignment!, runtimeMode: saved.runtimeMode },
          library,
        );
        assert.equal(policy.runtimeMode, "full-access");
        assert.notProperty(policy, "sandboxPolicy");
        assert.notProperty(policy, "approvalPolicy");
        assert.include(policy.agentPersonaInstructions!, "Selected behavior: critic-review");
        assert.include(policy.agentPersonaInstructions!, "Never commit or push.");
        const original = yield* library.readSnapshot(saved.assignment!);
        assert.include(policy.agentPersonaInstructions!, original.instructions);
        yield* launcher.addSeats({
          providerSessionId: "session",
          requestKey: "saved-override-add",
          captain,
          instance,
          seats: [personaSeat],
          resolvedSeats: personaOverride,
        });
        const savedCommand = (yield* Ref.get(commands)).findLast(
          (command) => command.type === "thread.create",
        );
        assert.equal(savedCommand?.type, "thread.create");
        if (savedCommand?.type === "thread.create") {
          assert.deepStrictEqual(savedCommand.modelSelection, personaSeat.modelSelection);
          assert.equal(savedCommand.runtimeMode, "full-access");
          assert.deepStrictEqual(savedCommand.agentPersonaAssignment, saved.assignment);
          yield* guardAgentPersonaThreadCreate(savedCommand, library, () =>
            Effect.succeed("claudeAgent"),
          );
        }
        for (const selection of [
          { ...custom.modelSelection, model: "missing" },
          { ...custom.modelSelection, options: [{ id: "effort", value: "unsupported" }] },
        ]) {
          const invalid = yield* launcher
            .resolveSeats(captain, [{ ...personaSeat, modelSelection: selection }])
            .pipe(Effect.flip);
          assert.equal(invalid._tag, "CrewLaunchSeatUnavailableError");
        }
        const modelOnly = (yield* launcher.resolveSeats(captain, [
          { ...personaSeat, runtimeMode: undefined },
        ]))[0]!;
        const defaultPolicy = yield* resolveAgentPersonaRuntime(
          { agentPersonaAssignment: modelOnly.assignment!, runtimeMode: modelOnly.runtimeMode },
          library,
        );
        assert.equal(modelOnly.runtime.access, "Read only");
        assert.equal(
          "sandboxPolicy" in defaultPolicy ? defaultPolicy.sandboxPolicy?.type : undefined,
          "readOnly",
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it("runtime previews show advertised variant and boolean thinking choices", () => {
  const configured = provider("instance", "opencode", [{ slug: "model", options: [] }]);
  const selected = { instanceId: configured.instanceId, model: "model" };
  const variantProvider: ServerProvider = {
    ...configured,
    models: configured.models.map((model) => ({
      ...model,
      capabilities: {
        optionDescriptors: [
          {
            id: "variant",
            label: "Reasoning",
            type: "select",
            options: [{ id: "deep", label: "Deep reasoning" }],
          },
        ],
      },
    })),
  };
  assert.equal(
    describeCrewSeatRuntime(
      "seat",
      { ...selected, options: [{ id: "variant", value: "deep" }] },
      variantProvider,
      "auto",
      null,
    ).reasoning,
    "Deep reasoning",
  );
  const thinkingProvider: ServerProvider = {
    ...configured,
    models: configured.models.map((model) => ({
      ...model,
      capabilities: {
        optionDescriptors: [
          { id: "thinking", label: "Thinking", type: "boolean", currentValue: false },
        ],
      },
    })),
  };
  assert.equal(
    describeCrewSeatRuntime(
      "seat",
      { ...selected, options: [{ id: "thinking", value: true }] },
      thinkingProvider,
      "auto",
      null,
    ).reasoning,
    "On",
  );
  assert.equal(
    describeCrewSeatRuntime("seat", selected, thinkingProvider, "auto", null).reasoning,
    "Off",
  );
});

it.effect("rejects inherited ACP access that the harness cannot enforce", () =>
  Effect.gen(function* () {
    const { context, commands, captain } = yield* fixture;
    const layer = crewLaunchLayer.pipe(
      Layer.provideMerge(
        dependencies(commands, [provider("acp", "acpRegistry", [{ slug: "model", options: [] }])]),
      ),
      Layer.provideMerge(Layer.succeedContext(context)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "j5-inherited-acp-" })),
      Layer.provideMerge(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const launcher = yield* CrewLaunchService;
      for (const runtimeMode of ["auto", "auto-accept-edits"] as const) {
        const failure = yield* launcher
          .resolveSeats({ ...captain, thread: { ...captain.thread, runtimeMode } }, [
            {
              name: "reviewer",
              agentId: null,
              reason: "Review",
              instructions: "Review",
              modelSelection: { instanceId: ProviderInstanceId.make("acp"), model: "model" },
            },
          ])
          .pipe(Effect.flip);
        assert.equal(failure._tag, "CrewLaunchSeatUnavailableError");
      }
      assert.lengthOf(yield* Ref.get(commands), 0);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect("refuses persona seats whose effective ACP access the harness cannot enforce", () =>
  Effect.gen(function* () {
    const { context, commands, captain } = yield* fixture;
    const layer = crewLaunchLayer.pipe(
      Layer.provideMerge(
        dependencies(commands, [provider("acp", "acpRegistry", [{ slug: "model", options: [] }])]),
      ),
      Layer.provideMerge(Layer.succeedContext(context)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "j5-persona-acp-" })),
      Layer.provideMerge(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const launcher = yield* CrewLaunchService;
      const seat = {
        name: "builder",
        agentId: "builder",
        reason: "Build",
        modelSelection: { instanceId: ProviderInstanceId.make("acp"), model: "model" },
      };
      // A workspace-write persona with no override: the harness cannot enforce its default.
      const inherited = yield* launcher.resolveSeats(captain, [seat]).pipe(Effect.flip);
      assert.equal(inherited._tag, "CrewLaunchSeatUnavailableError");
      assert.include(inherited.message, "cannot enforce the persona's default access");
      // An explicit auto mode is refused on the persona branch as it is for custom seats.
      for (const runtimeMode of ["auto", "auto-accept-edits"] as const) {
        const overridden = yield* launcher
          .resolveSeats(captain, [{ ...seat, runtimeMode }])
          .pipe(Effect.flip);
        assert.equal(overridden._tag, "CrewLaunchSeatUnavailableError");
        assert.include(overridden.message, "cannot enforce the selected access mode");
      }
      // Modes the harness enforces itself pass, and the approval-bound preview records them.
      const allowed = yield* launcher.resolveSeats(captain, [
        { ...seat, runtimeMode: "approval-required" },
      ]);
      assert.equal(allowed[0]?.runtimeMode, "approval-required");
      assert.lengthOf(yield* Ref.get(commands), 0);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect("pins non-reasoning provider defaults for persona seats without overrides", () =>
  Effect.gen(function* () {
    const { context, commands, captain } = yield* fixture;
    const codex = provider("codex", "codex", [{ slug: "gpt-5.6-sol", options: ["high"] }]);
    const configured = (fastMode: boolean): ServerProvider => ({
      ...codex,
      models: codex.models.map((model) => ({
        ...model,
        capabilities: {
          optionDescriptors: [
            ...model.capabilities!.optionDescriptors!,
            {
              id: "fastMode",
              label: "Fast",
              type: "boolean",
              currentValue: fastMode,
            },
          ],
        },
      })),
    });
    const providers = [configured(true)];
    const layer = crewLaunchLayer.pipe(
      Layer.provideMerge(dependencies(commands, providers)),
      Layer.provideMerge(Layer.succeedContext(context)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "j5-persona-defaults-" })),
      Layer.provideMerge(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const launcher = yield* CrewLaunchService;
      const seats = [{ name: "builder", agentId: "builder", reason: "Build" }];
      const before = (yield* launcher.resolveSeats(captain, seats))[0]!;
      assert.deepStrictEqual(
        before.modelSelection.options?.find((option) => option.id === "fastMode"),
        { id: "fastMode", value: true },
      );
      assert.deepStrictEqual(before.assignment?.resolvedModelSelection, before.modelSelection);
      providers[0] = configured(false);
      const after = (yield* launcher.resolveSeats(captain, seats))[0]!;
      assert.equal(before.runtime.reasoning, after.runtime.reasoning);
      assert.deepStrictEqual(
        after.modelSelection.options?.find((option) => option.id === "fastMode"),
        { id: "fastMode", value: false },
      );
      assert.notDeepEqual(before, after);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect(
  "refuses edited instructions after a partial launch already dispatched that seat's brief",
  () =>
    Effect.gen(function* () {
      const { context, commands, captain } = yield* fixture;
      const stable = { providerSessionId: "session", requestKey: "partial-brief" };
      const failedThread = spawnThreadId({
        ...stable,
        requestKey: crewSeatRequestKey(stable.requestKey, "second"),
      });
      const layer = crewLaunchLayer.pipe(
        Layer.provideMerge(
          dependencies(
            commands,
            [provider("codex", "codex", [{ slug: "gpt-5.6-sol", options: ["high"] }])],
            new Set(),
            new Set(),
            new Set(),
            true,
            new Set([failedThread]),
          ),
        ),
        Layer.provideMerge(Layer.succeedContext(context)),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "j5-retry-instructions-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const launcher = yield* CrewLaunchService;
        const seats = ["first", "second"].map((name) => ({
          name,
          agentId: null,
          reason: "Review",
          instructions: "Original instructions",
        }));
        const input = {
          ...stable,
          captain,
          seats,
          displayName: "Review",
          brief: "Review the change",
          resolvedSeats: yield* launcher.resolveSeats(captain, seats),
        };
        yield* launcher.launch(input).pipe(Effect.flip);
        const dispatched = (yield* Ref.get(commands)).filter(
          (command) => command.type === "message.dispatch",
        );
        assert.lengthOf(dispatched, 1);
        const edited = seats.map((seat) =>
          seat.name === "first" ? { ...seat, instructions: "New instructions" } : seat,
        );
        const rejected = yield* launcher
          .launch({
            ...input,
            seats: edited,
            resolvedSeats: yield* launcher.resolveSeats(captain, edited),
          })
          .pipe(Effect.flip);
        assert.equal(rejected._tag, "CrewLaunchOperationError");
        assert.include(rejected.message, "already dispatched a different brief");
        assert.deepStrictEqual(
          (yield* Ref.get(commands)).filter((command) => command.type === "message.dispatch"),
          dispatched,
        );
        yield* launcher.launch(input);
        assert.isTrue(
          (yield* Ref.get(commands)).some(
            (command) => command.type === "message.dispatch" && command.threadId === failedThread,
          ),
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect("a retry that drops the failed seat keeps the briefs the other seats already have", () =>
  Effect.gen(function* () {
    const { context, commands, captain } = yield* fixture;
    const stable = { providerSessionId: "session", requestKey: "partial-drop" };
    const failedThread = spawnThreadId({
      ...stable,
      requestKey: crewSeatRequestKey(stable.requestKey, "second"),
    });
    const layer = crewLaunchLayer.pipe(
      Layer.provideMerge(
        dependencies(
          commands,
          [provider("codex", "codex", [{ slug: "gpt-5.6-sol", options: ["high"] }])],
          new Set(),
          new Set(),
          new Set(),
          true,
          new Set([failedThread]),
        ),
      ),
      Layer.provideMerge(Layer.succeedContext(context)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "j5-retry-drop-" })),
      Layer.provideMerge(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const launcher = yield* CrewLaunchService;
      const crews = yield* AgentCrewInstanceService;
      const seats = ["first", "second"].map((name) => ({
        name,
        agentId: null,
        reason: "Review",
        instructions: "Original instructions",
      }));
      const input = {
        ...stable,
        captain,
        seats,
        displayName: "Review",
        brief: "Review the change",
        resolvedSeats: yield* launcher.resolveSeats(captain, seats),
      };
      yield* launcher.launch(input).pipe(Effect.flip);
      const dispatched = (yield* Ref.get(commands)).filter(
        (command) => command.type === "message.dispatch",
      );
      assert.lengthOf(dispatched, 1);
      // The person drops the failed seat and approves: first's roster block changes, its brief
      // and instructions do not, so the retry converges instead of refusing.
      const kept = seats.filter((seat) => seat.name === "first");
      const instance = yield* launcher.launch({
        ...input,
        seats: kept,
        resolvedSeats: yield* launcher.resolveSeats(captain, kept),
      });
      assert.deepStrictEqual(
        (yield* crews.read(instance.id))!.members.map(({ seatName }) => seatName),
        ["first"],
      );
      // The replayed brief carries first's stable message id, so the orchestrator drops it as a
      // duplicate; nothing was started for the dropped seat.
      const briefs = (yield* Ref.get(commands)).filter(
        (command) => command.type === "message.dispatch",
      );
      assert.isTrue(briefs.every((brief) => brief.threadId === dispatched[0]!.threadId));
      assert.isTrue(
        briefs.every(
          (brief) =>
            brief.type === "message.dispatch" && brief.messageId === dispatched[0]!.messageId,
        ),
      );
      assert.isFalse(briefs.some((brief) => brief.threadId === failedThread));
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

/**
 * The real launcher and the real unit archive over one Crew store, so a launch or addition and an
 * archive can be interleaved step by step. Every unit step announces its Crew on `entered` as it
 * asks for the Crew's lock; a member archive can be held open with `holdArchive`, a spawn with
 * `beforeDispatch`. Seat facts come from the commands that landed: a seat with no thread.create
 * reads as never created, as the real archive reads a thread with neither home nor projection.
 */
const unitFixture = Effect.gen(function* () {
  const { context, commands, captain } = yield* fixture;
  const codex = provider("codex", "codex", [
    { slug: "gpt-5.6-sol", options: ["high"] },
    { slug: "gpt-5.6-terra", options: ["high"] },
  ]);
  const entered = yield* Queue.unbounded<string>();
  const archivedSeats = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const factsRead = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const holdArchive = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  const holdDispatch = yield* Ref.make<
    (command: OrchestrationV2Command) => Effect.Effect<void, OrchestratorDispatchError>
  >(() => Effect.void);
  const real = Context.get(context, AgentCrewInstanceService);
  const crews = Layer.succeed(AgentCrewInstanceService, {
    ...real,
    serialize: (id, effect) =>
      Queue.offer(entered, id).pipe(Effect.andThen(real.serialize(id, effect))),
  });
  const created = (threadId: ThreadId) =>
    Ref.get(commands).pipe(
      Effect.map((items) =>
        items.some((command) => command.type === "thread.create" && command.threadId === threadId),
      ),
    );
  const archiveAgent = Layer.mock(ArchiveAgentService)({
    readFacts: (target) =>
      Effect.gen(function* () {
        yield* Ref.update(factsRead, (items) => [...items, target.threadId]);
        if (!(yield* created(target.threadId))) return null;
        const archived = (yield* Ref.get(archivedSeats)).includes(target.threadId);
        return {
          facts: { openExchanges: [], runningTurn: null },
          threadArchived: archived,
          retired: archived,
        };
      }),
    archive: (input) =>
      Effect.gen(function* () {
        yield* Effect.flatten(Ref.get(holdArchive));
        yield* Ref.update(archivedSeats, (items) => [...items, input.target.threadId]);
        return "archived" as const;
      }),
  });
  const layer = Layer.mergeAll(
    crewLaunchLayer,
    archiveCrewLayer.pipe(
      Layer.provide(archiveAgent),
      Layer.provide(
        Layer.mock(ServerSecretStore)({
          getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(7)),
        }),
      ),
    ),
  ).pipe(
    Layer.provideMerge(crews),
    Layer.provideMerge(
      dependencies(commands, [codex], new Set(), new Set(), new Set(), true, new Set(), (command) =>
        Ref.get(holdDispatch).pipe(Effect.flatMap((hold) => hold(command))),
      ),
    ),
    Layer.provideMerge(Layer.succeedContext(context)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "j5-crew-unit-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  const archiveInput = (crewInstanceId: string) => ({
    providerSessionId: "session",
    callerParticipantId: null,
    squadronId: null,
    crewInstanceId,
    clientRequestKey: "archive-1",
    confirmationSatisfied: true,
    archivedAt: "2026-09-09T17:00:00.000Z",
    commandIds: (seat: string) => ({
      interruptCommandId: CommandId.make(`interrupt:${seat}`),
      archiveCommandId: CommandId.make(`archive:${seat}`),
    }),
  });
  const seatThread = (requestKey: string, seat: string) =>
    spawnThreadId({
      providerSessionId: "session",
      requestKey: crewSeatRequestKey(requestKey, seat),
    });
  const launchPair = Effect.gen(function* () {
    const launcher = yield* CrewLaunchService;
    return yield* launcher.launch({
      providerSessionId: "session",
      requestKey: "unit-1",
      captain,
      displayName: "Review Pair",
      seats: [{ name: "builder", agentId: "builder", reason: "Implements" }],
      brief: "Ship the login fix.",
    });
  });
  const addSentry = (instance: AgentCrewInstance) =>
    Effect.gen(function* () {
      const launcher = yield* CrewLaunchService;
      return yield* launcher.addSeats({
        providerSessionId: "session",
        requestKey: "add-sentry",
        captain,
        instance,
        seats: [{ name: "sentry", agentId: "sentry", reason: "Security pass" }],
      });
    });
  return {
    layer,
    commands,
    entered,
    archivedSeats,
    factsRead,
    holdArchive,
    holdDispatch,
    archiveInput,
    seatThread,
    launchPair,
    addSentry,
  };
});

it.effect(
  "an addition approved while the unit archive runs is refused before any seat of it exists",
  () =>
    Effect.gen(function* () {
      const unit = yield* unitFixture;
      yield* Effect.gen(function* () {
        const archive = yield* ArchiveCrewService;
        const crews = yield* AgentCrewInstanceService;
        const instance = yield* unit.launchPair;
        yield* Queue.clear(unit.entered);

        // The archive has read the roster and is retiring its first member when the addition,
        // already past the gate's checks, asks to reserve its seat. This proves the outcome, not
        // the lock: without it the addition may still happen to reserve after the stamp. The
        // mid-spawn test below is the one that fails without the lock.
        const archiving = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* Ref.set(
          unit.holdArchive,
          Deferred.succeed(archiving, undefined).pipe(Effect.andThen(Deferred.await(release))),
        );
        const archiveFiber = yield* archive
          .archive(unit.archiveInput(instance.id))
          .pipe(Effect.forkChild);
        yield* Deferred.await(archiving);
        const addFiber = yield* unit.addSentry(instance).pipe(Effect.flip, Effect.forkChild);
        assert.deepStrictEqual(
          [yield* Queue.take(unit.entered), yield* Queue.take(unit.entered)],
          [instance.id, instance.id],
        );
        yield* Deferred.succeed(release, undefined);

        const archived = yield* Fiber.join(archiveFiber);
        assert.equal(archived.status, "archived");
        assert.deepStrictEqual(
          archived.members.map((member) => member.seatName),
          ["builder"],
        );
        const refused = yield* Fiber.join(addFiber);
        assert.equal(refused._tag, "CrewLaunchOperationError");
        assert.include(refused.message, "is retired");

        const sentry = unit.seatThread("add-sentry", "sentry");
        const commands = yield* Ref.get(unit.commands);
        assert.isFalse(
          commands.some((command) => "threadId" in command && command.threadId === sentry),
        );
        const after = (yield* crews.read(instance.id))!;
        assert.isNotNull(after.archivedAt);
        assert.deepStrictEqual(
          after.members.map((member) => member.seatName),
          ["builder"],
        );
      }).pipe(Effect.provide(unit.layer));
    }).pipe(Effect.scoped),
);

it.effect(
  "a unit archive that arrives while an addition spawns reads the roster after the seat exists and retires it",
  () =>
    Effect.gen(function* () {
      const unit = yield* unitFixture;
      yield* Effect.gen(function* () {
        const archive = yield* ArchiveCrewService;
        const crews = yield* AgentCrewInstanceService;
        const instance = yield* unit.launchPair;
        yield* Queue.clear(unit.entered);
        const sentry = unit.seatThread("add-sentry", "sentry");

        // The addition has reserved its row and its seat thread is being created.
        const spawning = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* Ref.set(unit.holdDispatch, (command) =>
          command.type === "thread.create" && command.threadId === sentry
            ? Deferred.succeed(spawning, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
        );
        const addFiber = yield* unit.addSentry(instance).pipe(Effect.forkChild);
        yield* Deferred.await(spawning);
        const reserved = (yield* crews.read(instance.id))!;
        assert.deepStrictEqual(
          reserved.members.map((member) => member.seatName),
          ["builder", "sentry"],
        );

        const archiveFiber = yield* archive
          .archive(unit.archiveInput(instance.id))
          .pipe(Effect.forkChild);
        assert.deepStrictEqual(
          [yield* Queue.take(unit.entered), yield* Queue.take(unit.entered)],
          [instance.id, instance.id],
        );
        // Waiting on the addition, the archive has not read a single seat.
        assert.lengthOf(yield* Ref.get(unit.factsRead), 0);
        yield* Deferred.succeed(release, undefined);

        const grown = yield* Fiber.join(addFiber);
        assert.deepStrictEqual(
          grown.members.map((member) => member.seatName),
          ["builder", "sentry"],
        );
        const archived = yield* Fiber.join(archiveFiber);
        assert.equal(archived.status, "archived");
        assert.deepStrictEqual(
          archived.members.map((member) => [member.seatName, member.result]),
          [
            ["builder", "archived"],
            ["sentry", "archived"],
          ],
        );
        assert.include(yield* Ref.get(unit.archivedSeats), sentry);
        assert.isNotNull((yield* crews.read(instance.id))!.archivedAt);
      }).pipe(Effect.provide(unit.layer));
    }).pipe(Effect.scoped),
);

it.effect(
  "a unit archive finishes over an addition that reserved its seat but never spawned it",
  () =>
    Effect.gen(function* () {
      const unit = yield* unitFixture;
      yield* Effect.gen(function* () {
        const archive = yield* ArchiveCrewService;
        const crews = yield* AgentCrewInstanceService;
        const instance = yield* unit.launchPair;
        const sentry = unit.seatThread("add-sentry", "sentry");
        yield* Ref.set(unit.holdDispatch, (command) =>
          command.type === "thread.create" && command.threadId === sentry
            ? Effect.fail(
                new OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                }),
              )
            : Effect.void,
        );
        const failed = yield* unit.addSentry(instance).pipe(Effect.flip);
        assert.equal(failed._tag, "CrewLaunchOperationError");
        assert.deepStrictEqual(
          (yield* crews.read(instance.id))!.members.map((member) => member.seatName),
          ["builder", "sentry"],
        );

        const archived = yield* archive.archive(unit.archiveInput(instance.id));
        assert.equal(archived.status, "archived");
        assert.deepStrictEqual(
          archived.members.map((member) => [member.seatName, member.result]),
          [
            ["builder", "archived"],
            ["sentry", "never_created"],
          ],
        );
        assert.notInclude(yield* Ref.get(unit.archivedSeats), sentry);
        const retired = (yield* crews.read(instance.id))!;
        assert.isNotNull(retired.archivedAt);
        // The reserved row stays on the retired roster; the result says it never ran.
        assert.deepStrictEqual(
          retired.members.map((member) => member.seatName),
          ["builder", "sentry"],
        );
      }).pipe(Effect.provide(unit.layer));
    }).pipe(Effect.scoped),
);
