import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  CommandId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2Command,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import { stringify as yamlStringify } from "yaml";
import { createPendingAttachmentId } from "../../attachmentStore.ts";
import * as ThreadMessageIntake from "../../orchestration-v2/ThreadMessageIntake.ts";
import * as ServerConfig from "../../config.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { definitionDigest, makeAgentPersonaLibrary } from "./agentPersonaLibrary.ts";
import { BUILT_IN_AGENT_PERSONAS } from "./agentPersonas.ts";
import {
  AGENT_MODEL_SWITCH_REFUSAL,
  AgentPersonaModelSwitch,
} from "./agentPersonaOrchestration.ts";
import { resolveAgentPersonaRuntime } from "./agentPersonaRuntime.ts";
import {
  launchTestAdapter,
  makeHarness,
  modelSelection,
  projectId,
} from "../test-support/threadLaunchHarness.ts";
import { personaLibraryLayer } from "../test-support/personaLibrary.ts";
import { noDocumentTextLayer } from "../test-support/documentText.ts";

const isThreadLaunchError = Schema.is(ThreadLaunch.ThreadLaunchError);
function launchInput(input: {
  readonly command: string;
  readonly thread: string;
  readonly message?: string;
  readonly workspace?: ThreadLaunch.ThreadLaunchWorkspaceStrategy;
}) {
  return {
    commandId: CommandId.make(input.command),
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

it.effect("refuses a former bundled persona when the library is empty", () => {
  const harness = makeHarness({ providers: [] });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = "thread:unconfigured-persona";
    const error = yield* launches
      .launch({
        ...launchInput({ command: "command:unconfigured-persona", thread: threadId }),
        agentPersona: { personaId: "scout" },
      })
      .pipe(Effect.flip);
    assert.equal(error.message, "This environment has no personas, so scout cannot launch.");
    assert.isNull(yield* threads.getThreadShell(ThreadId.make(threadId)));
  }).pipe(Effect.provide(harness.layer));
});

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
        personaId: "scout",
        definitionVersion: 1,
        definitionDigest: definitionDigest(BUILT_IN_AGENT_PERSONAS.scout),
        displayName: "Scout",
        authorityPolicy: "read-only",
        resolvedRoute: "primary",
        resolvedEntryIndex: 0,
        resolvedDriver: ProviderDriverKind.make("codex"),
        resolvedModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-terra",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
        pickSource: { kind: "person" },
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
      assert.equal(switchError.cause, AGENT_MODEL_SWITCH_REFUSAL);

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
      assert.equal(messageOverrideError.cause, AGENT_MODEL_SWITCH_REFUSAL);

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
          Layer.provideMerge(
            personaLibraryLayer("j5-direct-persona-", [BUILT_IN_AGENT_PERSONAS.scout]),
          ),
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
      assert.equal(error._tag, "ThreadLaunchError");
      assert.equal(
        error._tag === "ThreadLaunchError" ? error.operation : undefined,
        "resolve-agent-persona",
      );
      assert.include(
        error.message,
        "Persona scout is blocked because none of its model entries can run: ",
      );
    }).pipe(
      Effect.provide(
        harness.layer.pipe(
          Layer.provideMerge(
            personaLibraryLayer("j5-blocked-persona-", [BUILT_IN_AGENT_PERSONAS.scout]),
          ),
        ),
      ),
      Effect.scoped,
    );
  }),
);

const reasoning = (...levels: ReadonlyArray<string>) => ({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select" as const,
      options: levels.map((id) => ({ id, label: id })),
    },
  ],
});
const signedIn = (
  instanceId: string,
  driver: string,
  models: ReadonlyArray<{ readonly slug: string; readonly levels: ReadonlyArray<string> }>,
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-06T00:00:00.000Z",
  availability: "available",
  slashCommands: [],
  skills: [],
  models: models.map(({ slug, levels }) => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: reasoning(...levels),
  })),
});
const switchProviders = [
  signedIn("codex", "codex", [
    { slug: "gpt-5.6-terra", levels: ["medium", "high"] },
    { slug: "gpt-5.6-sol", levels: ["high"] },
  ]),
  signedIn("claudeAgent", "claudeAgent", [{ slug: "claude-opus-5", levels: ["high"] }]),
];
const selection = (instanceId: string, model: string, effort: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
  options: [{ id: "reasoningEffort", value: effort }],
});
/** As a person's client sends it through `CommandAdmission`. */
const asPerson = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(AgentPersonaModelSwitch, { providers: Effect.succeed(switchProviders) }),
  );
const switchHarness = () =>
  makeHarness({
    providers: switchProviders,
    adapters: [
      launchTestAdapter(
        ProviderInstanceId.make("claudeAgent"),
        ProviderDriverKind.make("claudeAgent"),
      ),
    ],
  });
const switchLayer = (harness: ReturnType<typeof makeHarness>) =>
  harness.layer.pipe(
    Layer.provideMerge(
      personaLibraryLayer("j5-switch-persona-", [
        BUILT_IN_AGENT_PERSONAS.scout,
        BUILT_IN_AGENT_PERSONAS.builder,
      ]),
    ),
  );
let switchCommand = 0;
const setModel = (threadId: ThreadId, modelSelection: ModelSelection): OrchestrationV2Command => {
  switchCommand += 1;
  return {
    type: "thread.model-selection.set",
    commandId: CommandId.make(`command:switch:${switchCommand}`),
    threadId,
    modelSelection,
  };
};

it.effect("lets a person switch a persona worker's model, and checks the switch again", () => {
  const harness = switchHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const library = yield* makeAgentPersonaLibrary;
    const launched = yield* launches.launch({
      ...launchInput({ command: "command:switch:scout", thread: "thread:switch:scout" }),
      agentPersona: { personaId: "scout" },
    });
    const launchedAssignment = launched.projection.thread.agentPersonaAssignment!;
    const launchedRuntime = yield* resolveAgentPersonaRuntime(launched.projection.thread, library);

    // Off the persona's list, on the same provider: allowed, and no entry index.
    const terraMedium = selection("codex", "gpt-5.6-terra", "medium");
    yield* asPerson(threads.dispatch(setModel(launched.threadId, terraMedium)));
    const { resolvedEntryIndex: _entry, ...withoutEntry } = launchedAssignment;
    assert.deepEqual((yield* threads.getThreadShell(launched.threadId))?.agentPersonaAssignment, {
      ...withoutEntry,
      resolvedRoute: "override",
      resolvedModelSelection: terraMedium,
      modelSwitchedBy: "person",
    });

    // Across providers, through a person's message: upstream's provider switch, and the
    // assignment names the list entry the new model matches.
    const opus = selection("claudeAgent", "claude-opus-5", "high");
    yield* asPerson(
      threads.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:switch:scout:message"),
        threadId: launched.threadId,
        messageId: MessageId.make("message:switch:scout"),
        text: "Carry on on Claude",
        attachments: [],
        modelSelection: opus,
        dispatchMode: { type: "start_immediately" },
      }),
    );
    const projection = yield* threads.getThreadProjection(launched.threadId);
    assert.deepEqual(projection.thread.modelSelection, opus);
    assert.deepInclude(projection.thread.agentPersonaAssignment, {
      definitionDigest: launchedAssignment.definitionDigest,
      pickSource: { kind: "person" },
      resolvedRoute: "override",
      resolvedEntryIndex: 1,
      resolvedDriver: ProviderDriverKind.make("claudeAgent"),
      resolvedModelSelection: opus,
      modelSwitchedBy: "person",
    });
    assert.deepEqual(projection.runs.at(-1)?.modelSelection, opus);
    assert.equal(projection.thread.providerInstanceId, ProviderInstanceId.make("claudeAgent"));
    // The next turn runs on the new model with the launch snapshot's instructions.
    const runtime = yield* resolveAgentPersonaRuntime(projection.thread, library);
    assert.equal(runtime.agentPersonaInstructions, launchedRuntime.agentPersonaInstructions);

    // A model no signed-in provider offers is refused, and the worker stays on its model.
    const notOffered = yield* asPerson(
      threads.dispatch(setModel(launched.threadId, selection("codex", "gpt-4-retired", "high"))),
    ).pipe(Effect.flip);
    assert.equal(
      notOffered.cause,
      "Codex does not advertise gpt-4-retired. The worker stays on its current model.",
    );
    const missingProvider = yield* asPerson(
      threads.dispatch(setModel(launched.threadId, selection("cursor", "composer-2", "high"))),
    ).pipe(Effect.flip);
    assert.equal(
      missingProvider.cause,
      "No signed-in provider offers composer-2 on cursor. The worker stays on its current model.",
    );

    // An agent's change, through a thread command or a message's selection, is refused.
    const agentSet = yield* threads
      .dispatch(setModel(launched.threadId, terraMedium))
      .pipe(Effect.flip);
    assert.equal(agentSet.cause, AGENT_MODEL_SWITCH_REFUSAL);
    const agentMessage = yield* threads
      .dispatch({
        type: "message.dispatch",
        createdBy: "agent",
        creationSource: "mcp",
        commandId: CommandId.make("command:switch:scout:agent-message"),
        threadId: launched.threadId,
        messageId: MessageId.make("message:switch:scout:agent"),
        text: "Move to Codex",
        attachments: [],
        modelSelection: terraMedium,
        dispatchMode: { type: "queue_after_active" },
      })
      .pipe(Effect.flip);
    assert.equal(agentMessage.cause, AGENT_MODEL_SWITCH_REFUSAL);
    assert.deepEqual(
      (yield* threads.getThreadShell(launched.threadId))?.agentPersonaAssignment
        ?.resolvedModelSelection,
      opus,
    );
  }).pipe(Effect.provide(switchLayer(harness)), Effect.scoped);
});

it.effect("refuses a switch to a provider that can't enforce the persona's access", () => {
  const harness = switchHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* launches.launch({
      ...launchInput({ command: "command:switch:builder", thread: "thread:switch:builder" }),
      agentPersona: { personaId: "builder" },
    });
    const refused = yield* asPerson(
      threads.dispatch(
        setModel(launched.threadId, selection("claudeAgent", "claude-opus-5", "high")),
      ),
    ).pipe(Effect.flip);
    assert.equal(
      refused.cause,
      "Claude can't enforce Workspace-write access, which this persona runs with. Pick a model on Codex. The worker stays on its current model.",
    );
    assert.deepEqual(
      (yield* threads.getThreadShell(launched.threadId))?.agentPersonaAssignment,
      launched.projection.thread.agentPersonaAssignment,
    );
  }).pipe(Effect.provide(switchLayer(harness)), Effect.scoped);
});

it.effect("lets a person switch a reviewer onto its author's model, and queues a switch", () => {
  const harness = switchHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* launches.launch({
      ...launchInput({ command: "command:switch:source", thread: "thread:switch:source" }),
      agentPersona: { personaId: "scout" },
    });
    const reviewIndependence = {
      outcome: "different-model",
      authorModels: ["claude-opus-5"],
      authorThreadIds: [],
      partlyUnknown: false,
      modelChosenBy: "server",
    } as const;
    const reviewer = ThreadId.make("thread:switch:reviewer");
    const launchedAssignment = launched.projection.thread.agentPersonaAssignment!;
    yield* threads.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:switch:reviewer:create"),
      threadId: reviewer,
      projectId,
      title: "Reviewer",
      modelSelection: launchedAssignment.resolvedModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      agentPersonaAssignment: {
        ...launchedAssignment,
        authorityPolicy: "read-only",
        reviewIndependence,
      },
    });
    const send = (id: string, modelSelection?: ModelSelection) =>
      asPerson(
        threads.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`command:switch:reviewer:${id}`),
          threadId: reviewer,
          messageId: MessageId.make(`message:switch:reviewer:${id}`),
          text: id,
          attachments: [],
          ...(modelSelection === undefined ? {} : { modelSelection }),
          dispatchMode: { type: "queue_after_active" },
        }),
      );
    // No provider runs here, so the first run stays active and the switch queues behind it.
    yield* send("first");
    const opus = selection("claudeAgent", "claude-opus-5", "high");
    yield* send("switch", opus);
    const queued = yield* threads.getThreadProjection(reviewer);
    assert.deepEqual(
      queued.thread.agentPersonaAssignment?.resolvedModelSelection,
      launchedAssignment.resolvedModelSelection,
    );
    assert.deepEqual(queued.runs.at(-1)?.status, "queued");
    assert.deepEqual(queued.runs.at(-1)?.modelSelection, opus);

    // Onto the author's model directly: allowed, and the creation-time check stays as recorded.
    yield* asPerson(threads.dispatch(setModel(reviewer, opus)));
    assert.deepInclude((yield* threads.getThreadShell(reviewer))?.agentPersonaAssignment, {
      resolvedModelSelection: opus,
      reviewIndependence,
      modelSwitchedBy: "person",
    });
  }).pipe(Effect.provide(switchLayer(harness)), Effect.scoped);
});

it.effect("follows a queued switch onto the assignment when its run starts", () => {
  const harness = switchHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* launches.launch({
      ...launchInput({ command: "command:switch:queued", thread: "thread:switch:queued" }),
      agentPersona: { personaId: "scout" },
    });
    const threadId = launched.threadId;
    const send = (id: string, modelSelection?: ModelSelection) =>
      asPerson(
        threads.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`command:switch:queued:${id}`),
          threadId,
          messageId: MessageId.make(`message:switch:queued:${id}`),
          text: id,
          attachments: [],
          ...(modelSelection === undefined ? {} : { modelSelection }),
          dispatchMode: { type: "queue_after_active" },
        }),
      );
    yield* send("first");
    const opus = selection("claudeAgent", "claude-opus-5", "high");
    yield* send("switch", opus);
    // Stop ends the active run and holds the queue; resuming starts the queued run.
    yield* threads.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("command:switch:queued:stop"),
      threadId,
    });
    yield* threads.dispatch({
      type: "queue.resume",
      commandId: CommandId.make("command:switch:queued:resume"),
      threadId,
    });
    const projection = yield* threads.getThreadProjection(threadId);
    assert.deepEqual(
      projection.runs.map(({ status, modelSelection }) => [status, modelSelection.model]),
      [
        ["interrupted", "gpt-5.6-terra"],
        ["starting", "claude-opus-5"],
      ],
    );
    assert.deepEqual(projection.thread.modelSelection, opus);
    assert.deepInclude(projection.thread.agentPersonaAssignment, {
      resolvedModelSelection: opus,
      resolvedDriver: ProviderDriverKind.make("claudeAgent"),
      resolvedEntryIndex: 1,
      modelSwitchedBy: "person",
    });
  }).pipe(Effect.provide(switchLayer(harness)), Effect.scoped);
});

const yamlPersonaFixture = (value: unknown) => yamlStringify(value);

it.effect(
  "launches an imported persona and replays its receipt after the source is removed",
  () => {
    const definition = {
      ...BUILT_IN_AGENT_PERSONAS.scout,
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
      assert.equal(disabledError._tag, "ThreadLaunchError");
      assert.equal(
        disabledError._tag === "ThreadLaunchError" ? disabledError.operation : undefined,
        "resolve-agent-persona",
      );
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
      assert.equal(error._tag, "ThreadLaunchError");
      assert.equal(
        error._tag === "ThreadLaunchError" ? error.operation : undefined,
        "resolve-agent-persona",
      );
      assert.include(error.message, "has no personas");
    }).pipe(
      Effect.provide(
        harness.layer.pipe(Layer.provideMerge(environment), Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.scoped,
    );
  },
);

it.effect(
  "launches a full-access persona unrestricted, replays it after the source is removed, and round-trips its export",
  () => {
    const definition = {
      ...BUILT_IN_AGENT_PERSONAS.scout,
      id: "unrestricted-builder",
      displayName: "Unrestricted Builder",
      version: 1,
      authority: {
        defaultPolicy: "full-access",
        allowedPolicies: ["full-access"],
      } as const,
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
          checkedAt: "2026-10-05T00:00:00.000Z",
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
    const environment = ServerConfig.layerTest("/repo", { prefix: "j5-persona-full-access-" });
    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const folder = path.join(config.stateDir, "personas");
      yield* fs.makeDirectory(folder, { recursive: true });
      yield* fs.writeFileString(path.join(folder, "builder.yaml"), yamlPersonaFixture(definition));
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const input = {
        ...launchInput({ command: "command:full-access", thread: "thread:full-access" }),
        agentPersona: { personaId: definition.id },
      };
      const launched = yield* launches.launch(input);
      const projection = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(projection.thread.agentPersonaAssignment?.authorityPolicy, "full-access");
      const library = yield* makeAgentPersonaLibrary;
      // The effective provider policy comes from the persona snapshot, not the stored thread mode.
      const policy = yield* resolveAgentPersonaRuntime(
        { ...projection.thread, runtimeMode: "approval-required" },
        library,
      );
      assert.equal(policy.runtimeMode, "full-access");
      assert.notProperty(policy, "sandboxPolicy");
      assert.notProperty(policy, "approvalPolicy");

      // Export and re-import keep the policy.
      yield* library.importFiles({
        files: [{ name: "agent.yaml", content: yamlPersonaFixture(definition) }],
        replaceExisting: true,
      });
      const exported = yield* library.read(definition.id);
      assert.deepEqual(exported.authority, definition.authority);
      yield* library.importFiles({
        files: [{ name: "agent.yaml", content: yamlPersonaFixture(exported) }],
        replaceExisting: true,
      });
      assert.deepEqual((yield* library.read(definition.id)).authority, definition.authority);

      // Replay after the source disappears still resolves the persisted snapshot.
      yield* library.removeImported(definition.id);
      yield* fs.remove(folder, { recursive: true });
      assert.equal((yield* launches.launch(input)).threadId, launched.threadId);
      const replayed = yield* resolveAgentPersonaRuntime(projection.thread, library);
      assert.equal(replayed.runtimeMode, "full-access");
      assert.notProperty(replayed, "sandboxPolicy");
    }).pipe(
      Effect.provide(
        harness.layer.pipe(Layer.provideMerge(environment), Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.scoped,
    );
  },
);

it.effect("releases claimed uploads when persona resolution refuses a launch", () => {
  const harness = makeHarness({ providers: [] });
  const environment = ServerConfig.layerTest("/repo", { prefix: "j5-persona-intake-" });
  return Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const id = ChatAttachmentId.make(createPendingAttachmentId());
    const pendingName = `${id}.png`;
    yield* fs.writeFile(path.join(config.attachmentsDir, pendingName), new Uint8Array([1, 2, 3]));
    const before = yield* fs.readDirectory(config.attachmentsDir);
    const error = yield* ThreadMessageIntake.launchThread({
      ...launchInput({ command: "command:blocked-upload", thread: "thread-blocked-upload" }),
      agentPersona: { personaId: "scout" },
      initialMessage: {
        messageId: MessageId.make("blocked-upload-message"),
        text: "Inspect this image",
        attachments: [
          { type: "image", id, name: "screen.png", mimeType: "image/png", sizeBytes: 3 },
        ],
      },
    }).pipe(Effect.flip);
    assert.instanceOf(error, ThreadLaunch.ThreadLaunchError);
    if (!isThreadLaunchError(error)) return;
    assert.equal(error.operation, "resolve-agent-persona");
    assert.deepStrictEqual(
      (yield* fs.readDirectory(config.attachmentsDir)).toSorted(),
      before.toSorted(),
    );
    assert.deepStrictEqual(
      yield* fs.readFile(path.join(config.attachmentsDir, pendingName)),
      new Uint8Array([1, 2, 3]),
    );
  }).pipe(
    Effect.provide(
      harness.layer.pipe(
        Layer.provideMerge(environment),
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(noDocumentTextLayer),
      ),
    ),
    Effect.scoped,
  );
});
