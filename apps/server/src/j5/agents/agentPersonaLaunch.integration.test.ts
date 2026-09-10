import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { stringify as yamlStringify } from "yaml";

import * as ServerConfig from "../../config.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import type { ProviderAdapterV2Shape } from "../../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadTitleRegeneration from "../../orchestration-v2/ThreadTitleRegenerationService.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import { makeProviderRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { SquadronThreadCreationService } from "../a2a/SquadronThreadCreationService.ts";
import { definitionDigest, makeAgentPersonaLibrary } from "./agentPersonaLibrary.ts";
import { TEST_PERSONAS } from "./testFixtures.ts";
import { resolveAgentPersonaRuntime } from "./agentPersonaRuntime.ts";

// The harness below mirrors orchestration-v2/ThreadLaunchService.test.ts so persona launch
// cases stay out of the upstream test file (FORK.md). Keep it in sync when that harness moves.
const projectId = ProjectId.make("project:launch-test");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;
const project = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: modelSelection,
  defaultThreadEnvMode: null,
  scripts: [],
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  deletedAt: null,
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in launch tests"),
} as ProviderAdapterV2Shape;

interface HarnessOptions {
  readonly createWorktree?: GitWorkflow.GitWorkflowService["Service"]["createWorktree"];
  readonly fetchRemote?: GitWorkflow.GitWorkflowService["Service"]["fetchRemote"];
  readonly renameBranch?: GitWorkflow.GitWorkflowService["Service"]["renameBranch"];
  readonly runSetup?: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"];
  readonly generateTitle?: TextGeneration.TextGeneration["Service"]["generateThreadTitle"];
  readonly generateBranchName?: TextGeneration.TextGeneration["Service"]["generateBranchName"];
  readonly serverSettings?: Parameters<typeof ServerSettings.layerTest>[0];
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly registerAtDurableLaunch?: SquadronThreadCreationService["Service"]["registerAtDurableLaunch"];
  readonly findRegisteredHome?: SquadronThreadCreationService["Service"]["findRegisteredHome"];
}

function makeHarness(options: HarnessOptions = {}) {
  const database = SqlitePersistenceMemory;
  const registry = ProviderAdapterRegistry.makeLayer([adapter]);
  const orchestrator = makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "thread-launch" },
    registry,
    { databaseLayer: database, runEffectWorker: false },
  );
  const threadManagement = ThreadManagement.layer.pipe(Layer.provide(orchestrator));
  const receipts = CommandReceiptStore.layer.pipe(Layer.provide(database));
  const outbox = EffectOutbox.layer.pipe(Layer.provide(database));
  const createWorktree = vi.fn(
    options.createWorktree ??
      ((input) =>
        Effect.succeed({
          worktree: { path: "/repo-worktrees/feature", refName: input.newRefName, headSha: "abc" },
        } as never)),
  );
  const renameBranch = vi.fn(
    options.renameBranch ?? ((input) => Effect.succeed({ branch: input.newBranch })),
  );
  const runSetup = vi.fn(
    options.runSetup ?? (() => Effect.succeed({ status: "no-script" as const })),
  );
  const generateBranchName = vi.fn(
    options.generateBranchName ?? (() => Effect.succeed({ branch: "generated-branch" })),
  );
  const generateThreadTitle = vi.fn(
    options.generateTitle ?? (() => Effect.succeed({ title: "Generated title" })),
  );
  const externalServices = Layer.mergeAll(
    Layer.succeed(ProjectService.ProjectService, {
      create: () => Effect.die("unused"),
      bootstrap: () => Effect.die("unused"),
      update: () => Effect.die("unused"),
      delete: () => Effect.die("unused"),
      getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
      getByWorkspaceRoot: () => Effect.succeed(Option.some(project)),
      snapshot: Effect.die("unused"),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      createWorktree,
      renameBranch,
      fetchRemote: options.fetchRemote ?? (() => Effect.void),
      remoteExists: () => Effect.succeed(true),
      remoteBranchExists: () => Effect.succeed(true),
      removeWorktree: () => Effect.void,
      resolveRemoteTrackingCommit: () =>
        Effect.succeed({ commitSha: "remote-main-sha", remoteRefName: "origin/main" }),
    }),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: runSetup,
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateThreadTitle,
      generateBranchName,
    }),
    ServerSettings.layerTest(options.serverSettings),
    makeProviderRegistryLayer(options.providers),
  );
  const launch = ThreadLaunch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        externalServices,
        threadManagement,
        receipts,
        IdAllocator.layer,
        Layer.mock(SquadronThreadCreationService)({
          registerAtDurableLaunch:
            options.registerAtDurableLaunch ??
            (() =>
              Effect.succeed({
                squadronId: "squadron:launch-test" as never,
                participantId: "agent:launch-test" as never,
              })),
          findRegisteredHome: options.findRegisteredHome ?? (() => Effect.succeed(null)),
        }),
      ),
    ),
  );
  const projectedProjects = Layer.mock(ProjectionProjectRepository)({
    getById: ({ projectId: requestedProjectId }) =>
      Effect.succeed(
        requestedProjectId === projectId
          ? Option.some({
              projectId,
              title: project.title,
              workspaceRoot: project.workspaceRoot,
              defaultModelSelection: project.defaultModelSelection,
              defaultThreadEnvMode: null,
              autoPull: false,
              scripts: project.scripts,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
              deletedAt: project.deletedAt,
            })
          : Option.none(),
      ),
  });
  const titleRegeneration = ThreadTitleRegeneration.layer.pipe(
    Layer.provide(Layer.mergeAll(threadManagement, projectedProjects, externalServices)),
  );
  return {
    layer: Layer.mergeAll(launch, threadManagement, titleRegeneration, outbox, database),
    createWorktree,
    renameBranch,
    generateBranchName,
    generateThreadTitle,
    runSetup,
  };
}

function launchInput(input: {
  readonly command: string;
  readonly thread: string;
  readonly message?: string;
  readonly workspace?: ThreadLaunch.ThreadLaunchWorkspaceStrategy;
  readonly squadronId?: string | null;
}) {
  return {
    commandId: CommandId.make(input.command),
    ...(input.squadronId === null
      ? {}
      : { squadronId: input.squadronId ?? "squadron:launch-test" }),
    threadId: ThreadId.make(input.thread),
    projectId,
    title: "New thread",
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    workspaceStrategy: input.workspace ?? { type: "root" as const },
    ...(input.message === undefined
      ? {}
      : {
          initialMessage: {
            messageId: MessageId.make(`${input.message}:id`),
            text: input.message,
            attachments: [],
          },
        }),
    createdBy: "user" as const,
    creationSource: "web" as const,
  };
}

it.effect("launches one persona directly without requiring workflow sequencing", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      providers: [
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-09-02T00:00:00.000Z",
          availability: "available",
          models: [
            {
              slug: "gpt-5.6-terra",
              name: "GPT-5.6 Terra",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "reasoningEffort",
                    label: "Reasoning",
                    type: "select",
                    options: [
                      { id: "medium", label: "Medium" },
                      { id: "high", label: "High" },
                    ],
                  },
                ],
              },
            },
          ],
          slashCommands: [],
          skills: [],
        },
      ],
    });

    yield* Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(config.stateDir, "personas"), { recursive: true });
      for (const definition of [TEST_PERSONAS.scout, TEST_PERSONAS.publisher])
        yield* fs.writeFileString(
          path.join(config.stateDir, "personas", `${definition.id}.yaml`),
          yamlStringify(definition),
        );
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const launched = yield* launches.launch({
        ...launchInput({
          command: "command:launch:agent-persona",
          thread: "thread:launch:agent-persona",
        }),
        agentPersona: { personaId: "scout" },
      });

      const expectedAssignment = {
        definitionDigest: definitionDigest(TEST_PERSONAS.scout),
        displayName: TEST_PERSONAS.scout.displayName,
        personaId: "scout",
        definitionVersion: 1,
        authorityPolicy: "read-only",
        resolvedRoute: "primary",
        resolvedDriver: ProviderDriverKind.make("codex"),
        resolvedModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-terra",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      } as const;
      assert.deepEqual(launched.projection.thread.agentPersonaAssignment, expectedAssignment);
      assert.deepEqual(
        launched.projection.thread.modelSelection,
        expectedAssignment.resolvedModelSelection,
      );
      assert.deepEqual(
        (yield* threads.getThreadShell(launched.threadId))?.agentPersonaAssignment,
        expectedAssignment,
      );

      const switchError = yield* threads
        .dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make("command:launch:agent-persona:switch"),
          threadId: launched.threadId,
          modelSelection,
        })
        .pipe(Effect.flip);
      assert.equal(
        switchError.cause,
        `Agent persona thread ${launched.threadId} has an immutable model route.`,
      );

      const messageOverrideError = yield* threads
        .dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:launch:agent-persona:model-override"),
          threadId: launched.threadId,
          messageId: MessageId.make("message:launch:agent-persona:model-override"),
          text: "Use another model",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        })
        .pipe(Effect.flip);
      assert.equal(
        messageOverrideError.cause,
        `Agent persona thread ${launched.threadId} has an immutable model route.`,
      );

      const publisherError = yield* launches
        .launch({
          ...launchInput({
            command: "command:launch:publisher-blocked",
            thread: "thread:launch:publisher-blocked",
          }),
          agentPersona: { personaId: "publisher" },
        })
        .pipe(Effect.flip);
      assert.equal(
        publisherError.message,
        "Agent persona publisher is blocked because neither route can enforce its authority policy.",
      );

      const invalidAuthorityError = yield* launches
        .launch({
          ...launchInput({
            command: "command:launch:persona-invalid-authority",
            thread: "thread:launch:persona-invalid-authority",
          }),
          agentPersona: { personaId: "scout", authorityPolicy: "publish-only" },
        })
        .pipe(Effect.flip);
      assert.equal(
        invalidAuthorityError.message,
        "Authority policy publish-only is not allowed for scout.",
      );
    }).pipe(
      Effect.provide(
        harness.layer.pipe(
          Layer.provideMerge(ServerConfig.layerTest("/repo", { prefix: "j5-persona-launch-" })),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
      Effect.scoped,
    );
  }),
);
it.effect("blocks a direct persona launch when both declared model routes are unavailable", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ providers: [] });

    yield* Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(config.stateDir, "personas"), { recursive: true });
      for (const definition of [TEST_PERSONAS.scout, TEST_PERSONAS.publisher])
        yield* fs.writeFileString(
          path.join(config.stateDir, "personas", `${definition.id}.yaml`),
          yamlStringify(definition),
        );
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const error = yield* launches
        .launch({
          ...launchInput({
            command: "command:launch:blocked-agent-persona",
            thread: "thread:launch:blocked-agent-persona",
          }),
          agentPersona: { personaId: "scout" },
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, ThreadLaunch.ThreadLaunchError);
      assert.equal(error.operation, "resolve-agent-persona");
      assert.equal(
        error.message,
        "Agent persona scout is blocked because its primary and fallback models are unavailable.",
      );
    }).pipe(
      Effect.provide(
        harness.layer.pipe(
          Layer.provideMerge(ServerConfig.layerTest("/repo", { prefix: "j5-persona-launch-" })),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
      Effect.scoped,
    );
  }),
);

const yamlPersonaFixture = (value: unknown) => yamlStringify(value);

it.effect(
  "launches an imported persona and replays its receipt after the source is removed",
  () => {
    const definition = {
      ...TEST_PERSONAS.scout,
      id: "team-researcher",
      displayName: "Team Researcher",
      version: 2,
    };
    const harness = makeHarness({
      providers: [
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-09-08T00:00:00.000Z",
          availability: "available",
          slashCommands: [],
          skills: [],
          models: [
            {
              slug: definition.modelRoute[0].model,
              name: "Research model",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "reasoningEffort",
                    label: "Reasoning",
                    type: "select",
                    options: [{ id: "high", label: "High" }],
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const environment = ServerConfig.layerTest("/repo", { prefix: "j5-persona-launch-" });
    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const folder = path.join(config.stateDir, "personas");
      yield* fs.makeDirectory(folder, { recursive: true });
      yield* fs.writeFileString(path.join(folder, "team.yaml"), yamlPersonaFixture(definition));
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const input = {
        ...launchInput({ command: "command:imported-persona", thread: "thread:imported-persona" }),
        agentPersona: { personaId: definition.id },
      };
      const launched = yield* launches.launch(input);
      const projection = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(projection.thread.agentPersonaAssignment?.displayName, definition.displayName);
      assert.match(
        projection.thread.agentPersonaAssignment?.definitionDigest ?? "",
        /^[a-f0-9]{64}$/,
      );
      const library = yield* makeAgentPersonaLibrary;
      yield* library.importFiles({
        files: [{ name: "agent.yaml", content: yamlPersonaFixture(definition) }],
        replaceExisting: true,
      });
      yield* library.setImportedEnabled(definition.id, false);
      const disabledError = yield* launches
        .launch({
          ...input,
          commandId: CommandId.make("command:imported-persona:disabled"),
          threadId: ThreadId.make("thread:imported-persona:disabled"),
        })
        .pipe(Effect.flip);
      assert.equal(disabledError.operation, "resolve-agent-persona");
      assert.include(disabledError.message, "disabled");
      assert.equal((yield* launches.launch(input)).threadId, launched.threadId);
      yield* library.setImportedEnabled(definition.id, true);
      const reenabled = yield* launches.launch({
        ...input,
        commandId: CommandId.make("command:imported-persona:enabled"),
        threadId: ThreadId.make("thread:imported-persona:enabled"),
      });
      assert.equal(
        reenabled.projection.thread.agentPersonaAssignment?.definitionDigest,
        projection.thread.agentPersonaAssignment?.definitionDigest,
      );
      yield* library.removeImported(definition.id);
      yield* fs.remove(folder, { recursive: true });
      const assignment = projection.thread.agentPersonaAssignment!;
      const { agentPersona: _request, ...preparedInput } = input;
      const prepared = yield* launches.launch({
        ...preparedInput,
        commandId: CommandId.make("command:pinned-persona"),
        threadId: ThreadId.make("thread:pinned-persona"),
        modelSelection: assignment.resolvedModelSelection,
        preparedPersonaAssignment: assignment,
      });
      assert.deepEqual(prepared.projection.thread.agentPersonaAssignment, assignment);
      const replay = yield* launches.launch(input);
      assert.equal(replay.threadId, launched.threadId);
      const policy = yield* resolveAgentPersonaRuntime(projection.thread, library);
      assert.include(
        "agentPersonaInstructions" in policy ? policy.agentPersonaInstructions : "",
        definition.instructions,
      );
      const error = yield* launches
        .launch({
          ...input,
          commandId: CommandId.make("command:imported-persona:missing"),
          threadId: ThreadId.make("thread:imported-persona:missing"),
        })
        .pipe(Effect.flip);
      assert.equal(error.operation, "resolve-agent-persona");
      assert.include(error.message, "Unknown agent persona");
    }).pipe(
      Effect.provide(
        harness.layer.pipe(Layer.provideMerge(environment), Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.scoped,
    );
  },
);
