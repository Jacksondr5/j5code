import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { agentPersonaDraftsTestLayer } from "../../test-support/agentPersonaDrafts.ts";
import { agentPersonaEscalationsTestLayer } from "../../test-support/agentPersonaEscalations.ts";
import {
  EnvironmentId,
  type OrchestratorMcpThreadInterruptInput,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../../mcp/McpHttpServer.ts";
import {
  McpInvocationContext,
  type McpInvocationScope,
} from "../../../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../../../mcp/McpToolAccess.testkit.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import { OrchestratorToolkit } from "../../../mcp/toolkits/orchestrator/tools.ts";
import { DispatchModeLimit } from "../../../orchestration-v2/DispatchModeLimit.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../../../provider/ProviderRegistry.ts";
import { permissiveCrewMemberModels } from "../../test-support/crewMemberModels.ts";
import { type AgentCrewInstance, AgentCrewInstanceService } from "../AgentCrewInstanceService.ts";
import { participantIdForThread } from "../HomeRegistrar.ts";
import {
  J5OrchestratorSurface,
  J5_ORCHESTRATOR_CAPABILITIES_DESCRIPTION,
} from "./orchestratorSurface.ts";
import * as J5OrchestratorSurfaceHandlers from "./orchestratorSurfaceHandlers.ts";

const threadId = ThreadId.make("thread:j5:orchestrator-surface");
const providerInstanceId = ProviderInstanceId.make("codex-j5-orchestrator-surface");
const invocation: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:j5:orchestrator-surface"),
  capabilities: new Set(["orchestration"] as const),
  issuedAt: 1,
  requestNamespace: "provider-session:j5:orchestrator-surface",
  thread: {
    threadId,
    providerSessionId: "provider-session:j5:orchestrator-surface",
    providerInstanceId,
  },
  client: undefined,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "j5-orchestrator-surface-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "j5-orchestrator-surface-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const rawCapabilities = {
  parentThreadId: threadId,
  inheritedProviderInstanceId: providerInstanceId,
  inheritedModel: "gpt-5.6-sol",
  inheritedOptions: [{ id: "effort", value: "xhigh" }],
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  providers: [
    {
      providerInstanceId,
      driverKind: ProviderDriverKind.make("codex"),
      displayName: "Codex",
      models: [
        {
          id: "gpt-5.6-sol",
          label: "GPT-5.6 Sol",
          options: [{ id: "effort", values: ["high", "xhigh"], default: "high" }],
        },
      ],
      omittedModels: 3,
      runtimeModes: ["approval-required", "full-access"] as const,
      canRunChildTask: false,
      canRunCrossProviderChildTask: false,
      constraints: ["Provider authentication is required."],
    },
  ],
  features: {
    appOwnedSubagents: true,
    asyncPolling: true,
    cancellation: true,
    batchThreadCreation: true,
    threadManagement: true,
    incrementalThreadRead: true,
    scheduledTasks: true,
    maxBatchThreads: 20,
  },
};

const searches: Array<string | undefined> = [];

const TestLayer = McpHttpServer.toolkitRegistration(
  J5OrchestratorSurface,
  J5OrchestratorSurfaceHandlers.layer,
).pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(OrchestratorMcpService)({
        capabilities: (_scope, input) => {
          searches.push(input?.search);
          return Effect.succeed(rawCapabilities);
        },
      }),
      Layer.mock(ThreadManagementService)({}),
      Layer.mock(AgentCrewInstanceService)({}),
      Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
      Layer.mock(ProviderRegistry)({}),
      permissiveCrewMemberModels,
      agentPersonaEscalationsTestLayer(),
      agentPersonaDraftsTestLayer(),
    ),
  ),
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
);

const hasKey = (value: unknown, key: string): boolean => {
  if (Array.isArray(value)) return value.some((item) => hasKey(item, key));
  if (typeof value !== "object" || value === null) return false;
  if (Object.hasOwn(value, key)) return true;
  return Object.values(value).some((item) => hasKey(item, key));
};

it.effect("registers the orchestrator tools J5 declares, with factual descriptions", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    expect(server.tools.map(({ tool }) => tool.name).sort()).toEqual([
      "delegate_task",
      "orchestrator_capabilities",
      "t3_thread_interrupt",
    ]);
    // J5's interrupt adds only a rule, so agents see upstream's tool as shipped.
    const interrupt = server.tools.find(({ tool }) => tool.name === "t3_thread_interrupt")?.tool;
    const upstream = OrchestratorToolkit.tools.t3_thread_interrupt;
    expect(interrupt?.description).toBe(upstream.description);
    const j5 = J5OrchestratorSurface.tools.t3_thread_interrupt;
    expect(j5.parametersSchema).toBe(upstream.parametersSchema);
    expect(j5.successSchema).toBe(upstream.successSchema);

    const description = server.tools.find(({ tool }) => tool.name === "orchestrator_capabilities")
      ?.tool.description;
    expect(description).toBe(J5_ORCHESTRATOR_CAPABILITIES_DESCRIPTION);
    // J5 hides upstream's launch tool, so its capabilities text must not point at it.
    expect(description).not.toContain("t3_thread_launch");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("maps capabilities with the inherited model and without delegation claims", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    searches.length = 0;
    const result = yield* server
      .callTool({ name: "orchestrator_capabilities", arguments: { search: "sonnet 4.6" } })
      .pipe(
        Effect.provideService(McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    expect(result.isError).toBe(false);
    expect(searches).toEqual(["sonnet 4.6"]);
    expect(result.structuredContent).toEqual({
      parentThreadId: threadId,
      // J5's instructions compare a child's selection with the parent's instance and model.
      inheritedProviderInstanceId: providerInstanceId,
      inheritedModel: "gpt-5.6-sol",
      // J5's instructions send same-model children through delegate_task when this is nonempty.
      inheritedOptions: [{ id: "effort", value: "xhigh" }],
      runtimeMode: "full-access",
      interactionMode: "default",
      providers: [
        {
          providerInstanceId,
          driverKind: "codex",
          displayName: "Codex",
          models: rawCapabilities.providers[0]!.models,
          omittedModels: 3,
          // Delegation refuses a runtime mode the provider does not list, so the caller sees them.
          runtimeModes: ["approval-required", "full-access"],
          constraints: ["Provider authentication is required."],
        },
      ],
      features: {
        incrementalThreadRead: true,
        scheduledTasks: true,
      },
    });

    for (const excluded of [
      "canRunChildTask",
      "canRunCrossProviderChildTask",
      "appOwnedSubagents",
      "asyncPolling",
      "cancellation",
      "threadManagement",
    ]) {
      expect(hasKey(result.structuredContent, excluded)).toBe(false);
    }
  }).pipe(Effect.provide(TestLayer)),
);

const captainThreadId = ThreadId.make("thread:j5:interrupt-captain");
const seatThreadId = ThreadId.make("thread:j5:interrupt-seat");
const seatRunId = RunId.make("run:j5:interrupt-seat");
const captainInvocation: McpInvocationScope = {
  ...invocation,
  thread: {
    threadId: captainThreadId,
    providerSessionId: "provider-session:j5:interrupt-captain",
    // liveThreadShell's instance, so the caller counts as live.
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
};

it.effect(
  "t3_thread_interrupt lets a Captain stop its own seat whatever its modes, and no one else",
  () =>
    Effect.gen(function* () {
      const callerMode = yield* Ref.make<RuntimeMode>("approval-required");
      const isSeat = yield* Ref.make(false);
      const dispatched = yield* Ref.make<
        ReadonlyArray<{ commandId: string; reason: string | undefined; limited: boolean }>
      >([]);
      const interrupted = yield* Ref.make<ReadonlyArray<{ reason: string | undefined }>>([]);
      const upstreamCalls = yield* Ref.make<ReadonlyArray<OrchestratorMcpThreadInterruptInput>>([]);
      const layer = McpHttpServer.toolkitRegistration(
        J5OrchestratorSurface,
        J5OrchestratorSurfaceHandlers.layer,
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(OrchestratorMcpService)({
              interruptThread: (_scope, input) =>
                Ref.update(upstreamCalls, (calls) => [...calls, input]).pipe(
                  Effect.as({
                    threadId: input.threadId,
                    runId: null,
                    status: "no_active_run" as const,
                  }),
                ),
            }),
            Layer.mock(ThreadManagementService)({
              getThreadShell: (id) =>
                id === captainThreadId
                  ? Effect.map(Ref.get(callerMode), (runtimeMode) =>
                      liveThreadShell(id, { runtimeMode }),
                    )
                  : Effect.succeed(liveThreadShell(id, { runtimeMode: "full-access" })),
              dispatch: (command) =>
                Effect.serviceOption(DispatchModeLimit).pipe(
                  Effect.flatMap((limit) =>
                    Ref.update(dispatched, (items) => [
                      ...items,
                      {
                        commandId: command.commandId,
                        reason: command.type === "thread.stop" ? command.reason : undefined,
                        limited: limit._tag === "Some" && limit.value !== undefined,
                      },
                    ]),
                  ),
                  Effect.as({
                    sequence: 1,
                    storedEvents: [
                      {
                        event: {
                          type: "run.updated",
                          runId: seatRunId,
                          payload: { status: "interrupted" },
                        },
                      },
                    ] as never,
                  }),
                ),
              interruptThread: (input) =>
                Ref.update(interrupted, (items) => [...items, { reason: input.reason }]).pipe(
                  Effect.as({ type: "no_active_run" as const }),
                ),
            }),
            Layer.mock(AgentCrewInstanceService)({
              findMembership: (participantId) =>
                Effect.map(Ref.get(isSeat), (seat) =>
                  seat && participantId === participantIdForThread(seatThreadId)
                    ? { crewInstanceId: "crew:j5:interrupt", seatName: "builder" }
                    : null,
                ),
              read: () =>
                Effect.succeed({
                  captainParticipantId: participantIdForThread(captainThreadId),
                } as AgentCrewInstance),
            }),
            Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
            Layer.mock(ProviderRegistry)({}),
            permissiveCrewMemberModels,
            agentPersonaEscalationsTestLayer(),
            agentPersonaDraftsTestLayer(),
          ),
        ),
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
      );

      yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const call = (args: Omit<OrchestratorMcpThreadInterruptInput, "environmentId">) =>
          server
            .callTool({ name: "t3_thread_interrupt", arguments: args })
            .pipe(
              Effect.provideService(McpInvocationContext, captainInvocation),
              Effect.provideService(McpSchema.McpServerClient, client),
            );

        // Not its Captain, and the seat runs in broader modes: upstream refuses it.
        const refused = yield* call({ threadId: seatThreadId, stop: true });
        expect(refused.isError).toBe(true);
        expect(yield* Ref.get(upstreamCalls)).toEqual([]);

        // Within the caller's modes it is upstream's tool, and an agent's Stop says so.
        yield* Ref.set(callerMode, "full-access");
        expect((yield* call({ threadId: seatThreadId, stop: true })).isError).toBe(false);
        expect((yield* call({ threadId: seatThreadId })).isError).toBe(false);
        expect((yield* Ref.get(upstreamCalls)).map((input) => input.reason)).toEqual([
          "Stopped by an agent",
          // Upstream words an interrupt's reason itself.
          undefined,
        ]);

        // Its Captain stops it from a narrower mode, with no limit for upstream to recheck.
        yield* Ref.set(callerMode, "approval-required");
        yield* Ref.set(isSeat, true);
        const stop = {
          threadId: seatThreadId,
          stop: true,
          reason: "replanning",
          clientRequestId: "stop-1",
        };
        const stopped = yield* call(stop);
        expect(stopped.isError).toBe(false);
        expect(stopped.structuredContent).toEqual({
          threadId: seatThreadId,
          runId: seatRunId,
          status: "interrupt_requested",
        });
        yield* call(stop);
        const stops = yield* Ref.get(dispatched);
        expect(stops.map(({ reason, limited }) => ({ reason, limited }))).toEqual([
          { reason: "Stopped by an agent: replanning", limited: false },
          { reason: "Stopped by an agent: replanning", limited: false },
        ]);
        // A retry repeats the same command.
        expect(stops[1]?.commandId).toBe(stops[0]?.commandId);

        const turn = yield* call({ threadId: seatThreadId });
        expect(turn.structuredContent).toEqual({
          threadId: seatThreadId,
          runId: null,
          status: "no_active_run",
        });
        expect(yield* Ref.get(interrupted)).toEqual([{ reason: "Stopped by an agent" }]);
        expect(yield* Ref.get(upstreamCalls)).toHaveLength(2);
      }).pipe(Effect.provide(layer));
    }),
);
