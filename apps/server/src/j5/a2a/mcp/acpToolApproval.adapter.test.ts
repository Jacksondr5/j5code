import * as NodeServices from "@effect/platform-node/NodeServices";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/compat";

import { ServerConfig } from "../../../config.ts";
import * as AcpSessionRuntime from "../../../provider/acp/AcpSessionRuntime.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
} from "../../../orchestration-v2/Adapters/AcpAdapterV2.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../../../orchestration-v2/IdAllocator.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2TurnInput,
} from "../../../orchestration-v2/ProviderAdapter.ts";

// Drives the real AcpAdapterV2 hooks end to end: a tool_call session/update lands in the turn's
// merged tool state, then the provider's approval request (session/request_permission or a
// codex-acp MCP-approval elicitation) is answered by the adapter. The mock agent only keeps the
// turn open; every provider frame below is fed through the handler the adapter registered.

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-j5-acp-approval-",
}).pipe(Layer.provide(NodeServices.layer));
const testLayer = Layer.mergeAll(NodeServices.layer, idAllocatorLayer, serverConfigLayer);

const DRIVER = ProviderDriverKind.make("acp-j5-approval-test");
const SESSION_ID = "mock-session-1";

type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
type PermissionHandler = Parameters<RuntimeService["handleRequestPermission"]>[0];
type ElicitationHandler = Parameters<RuntimeService["handleElicitation"]>[0];
type SessionUpdateHandler = Parameters<RuntimeService["handleSessionUpdate"]>[0];
type ToolCallUpdate = Extract<
  EffectAcpSchema.SessionNotification["update"],
  { sessionUpdate: "tool_call" }
>;
type PermissionToolCall = EffectAcpSchema.RequestPermissionRequest["toolCall"];

const APPROVAL_REQUIRED = { runtimeMode: "approval-required" } as const;
// How personas run: approval policy never in a read-only sandbox.
const PERSONA = {
  runtimeMode: "approval-required",
  approvalPolicy: "never",
  sandboxPolicy: { type: "readOnly" },
} as const;

const ALLOW_ONCE = { optionId: "allow-once", name: "Allow once", kind: "allow_once" } as const;
const ALLOW_ALWAYS = {
  optionId: "allow-always",
  name: "Allow always",
  kind: "allow_always",
} as const;
const REJECT_ONCE = { optionId: "reject-once", name: "Reject", kind: "reject_once" } as const;
const ALL_OPTIONS = [ALLOW_ALWAYS, ALLOW_ONCE, REJECT_ONCE];

// Verbatim shapes from AcpRuntimeModel.test.ts, with the tool swapped in.
const codexAcpCall = (toolCallId: string, tool: string): ToolCallUpdate => ({
  sessionUpdate: "tool_call",
  toolCallId,
  kind: "execute",
  title: `mcp.t3-code.${tool}`,
  status: "in_progress",
  rawInput: { server: "t3-code", tool, arguments: {} },
  _meta: { is_mcp_tool_call: true },
});
const qwenCall = (toolCallId: string, tool: string): ToolCallUpdate => ({
  sessionUpdate: "tool_call",
  toolCallId,
  kind: "other",
  title: "unrelated display title",
  status: "pending",
  _meta: { toolName: `mcp::t3-code::${tool}`, serverId: "t3-code", provenance: "mcp" },
});
const claudeAcpCall = (toolCallId: string, tool: string): ToolCallUpdate => ({
  sessionUpdate: "tool_call",
  toolCallId,
  kind: "other",
  title: `mcp__t3-code__${tool}`,
  status: "pending",
  _meta: { claudeCode: { toolName: `mcp__t3-code__${tool}` } },
});

// A permission request carrying only what every harness sends; identity must come from state.
const sparse = (update: ToolCallUpdate): PermissionToolCall => ({
  toolCallId: update.toolCallId,
  title: update.title,
  ...(update.kind === undefined ? {} : { kind: update.kind }),
});

type Verdict =
  | { readonly _tag: "asked" }
  | { readonly _tag: "selected"; readonly optionId: string }
  | { readonly _tag: "cancelled" };

const makeTurnInput = (input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly instanceId: ProviderInstanceId;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  readonly now: DateTime.Utc;
}): ProviderAdapterV2TurnInput => {
  const suffix = `${input.threadId}:1`;
  const modelSelection = { instanceId: input.instanceId, model: "default" } as const;
  return {
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId: ProjectId.make(`project:${input.threadId}`),
      title: "J5 ACP approval test",
      providerInstanceId: input.instanceId,
      modelSelection,
      runtimeMode: input.runtimePolicy.runtimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: input.providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    threadId: input.threadId,
    runId: RunId.make(`run:${suffix}`),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make(`attempt:${suffix}`),
    rootNodeId: NodeId.make(`node:${suffix}`),
    providerThread: input.providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make(`message:${suffix}`),
      text: "test prompt",
      attachments: [],
    },
    modelSelection,
    runtimePolicy: input.runtimePolicy,
  };
};

let sessions = 0;
/** Opens one adapter session with a turn held open and the adapter's provider handlers captured. */
const openTurn = Effect.fnUntraced(function* (
  policy: Pick<ProviderAdapterV2RuntimePolicy, "runtimeMode"> &
    Partial<Pick<ProviderAdapterV2RuntimePolicy, "approvalPolicy" | "sandboxPolicy">>,
) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  const mockAgentPath = yield* path.fromFileUrl(
    new URL("../../../../scripts/acp-mock-agent.ts", import.meta.url),
  );
  let permission: PermissionHandler | undefined;
  let elicitation: ElicitationHandler | undefined;
  let sessionUpdate: SessionUpdateHandler | undefined;
  const label = `j5-acp-approval-${++sessions}`;
  const instanceId = ProviderInstanceId.make(label);
  const adapter = makeAcpAdapterV2({
    crypto: yield* Crypto.Crypto,
    instanceId,
    flavor: {
      driver: DRIVER,
      capabilities: AcpProviderCapabilitiesV2,
      makeRuntime: (runtimeInput) =>
        Effect.gen(function* () {
          const context = yield* Layer.build(
            AcpSessionRuntime.layer({
              ...runtimeInput,
              spawn: {
                command: process.execPath,
                args: [mockAgentPath],
                cwd: runtimeInput.cwd,
                env: { T3_ACP_SESSION_LIFECYCLE: "1", T3_ACP_HANG_PROMPT_FOREVER: "1" },
              },
              authMethodId: "test",
            }).pipe(
              Layer.provide(
                Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
              ),
            ),
          );
          const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
            Effect.provide(context),
          );
          return {
            ...runtime,
            handleRequestPermission: (handler) =>
              Effect.sync(() => {
                permission = handler;
              }).pipe(Effect.andThen(runtime.handleRequestPermission(handler))),
            handleElicitation: (handler) =>
              Effect.sync(() => {
                elicitation = handler;
              }).pipe(Effect.andThen(runtime.handleElicitation(handler))),
            handleSessionUpdate: (handler) =>
              Effect.sync(() => {
                sessionUpdate = handler;
              }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
          } satisfies RuntimeService;
        }),
    },
    fileSystem: yield* FileSystem.FileSystem,
    idAllocator: yield* IdAllocatorV2,
    serverConfig: yield* ServerConfig,
    selfInvocation: yield* resolveSelfInvocation(),
  });
  const threadId = ThreadId.make(`thread-${label}`);
  const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
    interactionMode: "default",
    cwd: process.cwd(),
    ...policy,
  });
  const modelSelection = { instanceId, model: "default" } as const;
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make(`provider-session-${label}`),
    modelSelection,
    runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const asked = yield* Queue.unbounded<void>();
  const turnActive = yield* Deferred.make<void>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) =>
      event.type === "provider_turn.updated"
        ? Deferred.succeed(turnActive, undefined)
        : event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending"
          ? Queue.offer(asked, undefined)
          : Effect.void,
    ),
    Effect.forkScoped,
  );
  yield* runtime
    .startTurn(
      makeTurnInput({
        threadId,
        providerThread,
        instanceId,
        runtimePolicy,
        now: yield* DateTime.now,
      }),
    )
    .pipe(Effect.forkScoped);
  // Provider frames only reach a turn's tool state once the adapter has made the turn active.
  yield* Deferred.await(turnActive);
  if (permission === undefined || elicitation === undefined || sessionUpdate === undefined)
    return yield* Effect.die("the adapter must register its provider handlers");
  const handlers = { permission, elicitation, sessionUpdate };

  let requests = 0;
  // Settles on whichever happens first: the adapter answers the provider itself, or it hands the
  // request to the user as a pending runtime request.
  const decide = <A, E>(answer: Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      const fiber = yield* answer.pipe(Effect.forkScoped);
      return yield* Effect.raceFirst(
        Fiber.join(fiber).pipe(Effect.map((response) => ({ answered: response }) as const)),
        Queue.take(asked).pipe(Effect.as({ answered: undefined })),
      );
    });

  return {
    feed: (update: ToolCallUpdate) => handlers.sessionUpdate({ sessionId: SESSION_ID, update }),
    permit: (
      toolCall: PermissionToolCall,
      options: EffectAcpSchema.RequestPermissionRequest["options"] = ALL_OPTIONS,
      sessionId: string = SESSION_ID,
    ) =>
      decide(
        handlers.permission(
          { sessionId, toolCall, options },
          { requestId: `permission-${++requests}`, method: "session/request_permission" },
        ),
      ).pipe(
        Effect.map(({ answered }): Verdict => {
          if (answered === undefined) return { _tag: "asked" };
          return answered.outcome.outcome === "selected"
            ? { _tag: "selected", optionId: String(answered.outcome.optionId) }
            : { _tag: "cancelled" };
        }),
      ),
    // codex-acp names its MCP approval elicitation after the tool call it gates.
    elicit: (toolCallId: string, sessionId: string = SESSION_ID) =>
      decide(
        handlers.elicitation(
          {
            sessionId,
            mode: "form",
            message: "Allow the t3-code MCP server to run this tool?",
            requestedSchema: { type: "object", properties: {} },
            _meta: { codex_approval_kind: "mcp_tool_call" },
          },
          { requestId: `mcp_tool_call_approval_${toolCallId}`, method: "session/elicitation" },
        ),
      ).pipe(Effect.map(({ answered }) => answered)),
  };
});

const live = <E>(
  name: string,
  body: () => Effect.Effect<
    void,
    E,
    Layer.Success<typeof testLayer> | import("effect/Scope").Scope
  >,
) => it.live(name, () => body().pipe(Effect.scoped, Effect.provide(testLayer)));

describe("J5 ACP pre-approval through AcpAdapterV2", () => {
  live("allows a coordination verb once for each tagged harness shape in approval-required", () =>
    Effect.gen(function* () {
      const turn = yield* openTurn(APPROVAL_REQUIRED);
      for (const shape of [codexAcpCall, qwenCall, claudeAcpCall]) {
        const update = shape(`${shape.name}-propose`, "propose_crew");
        yield* turn.feed(update);
        assert.deepEqual(
          yield* turn.permit(sparse(update)),
          {
            _tag: "selected",
            optionId: ALLOW_ONCE.optionId,
          },
          shape.name,
        );
      }
    }),
  );

  live("still asks for spawning in approval-required and never picks allow_always", () =>
    Effect.gen(function* () {
      const turn = yield* openTurn(APPROVAL_REQUIRED);
      const update = codexAcpCall("codex-spawn", "spawn_agent");
      yield* turn.feed(update);
      assert.deepEqual(yield* turn.permit(sparse(update)), { _tag: "asked" });
    }),
  );

  live("lets a read-only persona under never spawn, but not hand off a worktree", () =>
    Effect.gen(function* () {
      const turn = yield* openTurn(PERSONA);
      const spawn = qwenCall("qwen-spawn", "spawn_agent");
      yield* turn.feed(spawn);
      assert.deepEqual(yield* turn.permit(sparse(spawn)), {
        _tag: "selected",
        optionId: ALLOW_ONCE.optionId,
      });
      const handoff = qwenCall("qwen-handoff", "t3_worktree_handoff");
      yield* turn.feed(handoff);
      assert.deepEqual(yield* turn.permit(sparse(handoff)), {
        _tag: "selected",
        optionId: REJECT_ONCE.optionId,
      });
    }),
  );

  live(
    "accepts a codex-acp MCP-approval elicitation for a coordination verb without persisting",
    () =>
      Effect.gen(function* () {
        const turn = yield* openTurn(APPROVAL_REQUIRED);
        yield* turn.feed(codexAcpCall("exec-propose", "propose_crew"));
        assert.deepEqual(yield* turn.elicit("exec-propose"), { action: "accept", content: {} });
        yield* turn.feed(codexAcpCall("exec-spawn", "spawn_agent"));
        assert.isUndefined(yield* turn.elicit("exec-spawn"), "spawn_agent is still asked");
      }),
  );

  live("never allows a call whose identity is not proven by prior tagged state", () =>
    Effect.gen(function* () {
      const turn = yield* openTurn(APPROVAL_REQUIRED);
      const asked = { _tag: "asked" } as const;
      // The code reviewer's case: a provider-supplied title on an `other` op.
      const titled = {
        toolCallId: "titled",
        title: "mcp__t3-code__propose_crew",
        kind: "other",
      } as const;
      assert.deepEqual(yield* turn.permit(titled, [ALLOW_ALWAYS]), asked, "title only");
      yield* turn.feed({ sessionUpdate: "tool_call", ...titled, status: "pending" });
      assert.deepEqual(yield* turn.permit(titled, [ALLOW_ALWAYS]), asked, "title in state too");
      assert.deepEqual(yield* turn.permit(titled), asked, "title in state, allow_once offered");
      for (const title of [
        "t3-code_propose_crew",
        "mcp__t3_code__propose_crew",
        "t3-code___propose_crew",
        "t3-code-propose_crew",
        "propose_crew (t3-code MCP Server)",
        "propose_crew_t3-code",
        "propose_crew",
      ]) {
        const toolCallId = `title-${title}`;
        yield* turn.feed({
          sessionUpdate: "tool_call",
          toolCallId,
          title,
          kind: "other",
          status: "pending",
        });
        assert.deepEqual(yield* turn.permit({ toolCallId, title, kind: "other" }), asked, title);
      }
      // Full tier-1 fields on the request itself, with no prior state.
      const unseen = codexAcpCall("unseen", "propose_crew");
      assert.deepEqual(
        yield* turn.permit({
          ...sparse(unseen),
          rawInput: { server: "t3-code", tool: "propose_crew", arguments: {} },
          _meta: { is_mcp_tool_call: true },
        }),
        asked,
        "no prior state",
      );
      // State for one tool, a request that names another.
      yield* turn.feed(codexAcpCall("swap", "propose_crew"));
      assert.deepEqual(
        yield* turn.permit({
          toolCallId: "swap",
          title: "mcp.t3-code.spawn_agent",
          kind: "execute",
          rawInput: { server: "t3-code", tool: "spawn_agent", arguments: {} },
        }),
        asked,
        "request contradicts the tool in state",
      );
      yield* turn.feed(codexAcpCall("kind-swap", "propose_crew"));
      assert.deepEqual(
        yield* turn.permit({
          toolCallId: "kind-swap",
          title: "mcp.t3-code.propose_crew",
          kind: "edit",
        }),
        asked,
        "kind differs from state",
      );
      // A tagged claude-acp name on a machine-acting kind.
      for (const kind of ["execute", "edit"] as const) {
        const update = { ...claudeAcpCall(`claude-${kind}`, "propose_crew"), kind };
        yield* turn.feed(update);
        assert.deepEqual(yield* turn.permit(sparse(update)), asked, `claudeCode on ${kind}`);
      }
      // The acp-mcp-call shell fallback and a foreign server.
      const fallback = {
        sessionUpdate: "tool_call",
        toolCallId: "fallback",
        kind: "execute",
        title: "node bin.ts acp-mcp-call propose_crew {}",
        status: "pending",
        rawInput: { command: "rm -rf x; node bin.ts acp-mcp-call propose_crew {}" },
      } as const satisfies ToolCallUpdate;
      yield* turn.feed(fallback);
      assert.deepEqual(yield* turn.permit(sparse(fallback)), asked, "acp-mcp-call");
      const foreign = {
        ...qwenCall("foreign", "propose_crew"),
        title: "mcp__t3-code__propose_crew",
        _meta: { serverId: "slack", toolName: "mcp::slack::propose_crew" },
      };
      yield* turn.feed(foreign);
      assert.deepEqual(yield* turn.permit(sparse(foreign)), asked, "foreign serverId");
      const bareTagged = {
        sessionUpdate: "tool_call",
        toolCallId: "bare-tagged",
        kind: "other",
        title: "propose_crew",
        status: "pending",
        _meta: { is_mcp_tool_call: true },
      } as const satisfies ToolCallUpdate;
      yield* turn.feed(bareTagged);
      assert.deepEqual(yield* turn.permit(sparse(bareTagged)), asked, "tag without a server");
    }),
  );

  live("allows only when every identity claim agrees on t3-code and the same tool", () =>
    Effect.gen(function* () {
      const turn = yield* openTurn(APPROVAL_REQUIRED);
      const asked = { _tag: "asked" } as const;
      const cases: ReadonlyArray<readonly [string, ToolCallUpdate]> = [
        [
          "tagged call to another server, T3-looking claudeCode name",
          {
            ...codexAcpCall("other-server-claude", "propose_crew"),
            rawInput: { server: "other", tool: "propose_crew", arguments: {} },
            _meta: {
              is_mcp_tool_call: true,
              claudeCode: { toolName: "mcp__t3-code__propose_crew" },
            },
          },
        ],
        [
          "tagged call to another server, T3-looking title",
          {
            ...codexAcpCall("other-server-title", "propose_crew"),
            title: "mcp__t3-code__propose_crew",
            rawInput: { server: "other", tool: "propose_crew", arguments: {} },
          },
        ],
        [
          "t3-code rawInput tool disagrees with the meta tool names",
          {
            ...codexAcpCall("tool-conflict", "propose_crew"),
            rawInput: { server: "t3-code", tool: "t3_worktree_handoff", arguments: {} },
            _meta: {
              is_mcp_tool_call: true,
              toolName: "mcp::t3-code::propose_crew",
              claudeCode: { toolName: "mcp__t3-code__propose_crew" },
            },
          },
        ],
        [
          "qwen serverId t3-code with another server's prefixed name",
          {
            ...qwenCall("qwen-other-prefix", "propose_crew"),
            _meta: { serverId: "t3-code", toolName: "mcp::other::propose_crew" },
          },
        ],
        [
          "qwen name with no boundary before the J5 tool",
          qwenCall("qwen-no-boundary", "xsend_message"),
        ],
        ["qwen non-J5 t3-code tool", qwenCall("qwen-handoff-asked", "t3_worktree_handoff")],
      ];
      for (const [label, update] of cases) {
        yield* turn.feed(update);
        assert.deepEqual(yield* turn.permit(sparse(update)), asked, label);
      }
      // Titles are never read, not even to veto: tagged state decides (Captain's ruling).
      const retitled = codexAcpCall("title-ignored", "propose_crew");
      yield* turn.feed(retitled);
      assert.deepEqual(
        yield* turn.permit({ ...sparse(retitled), title: "mcp__t3-code__spawn_agent" }),
        { _tag: "selected", optionId: ALLOW_ONCE.optionId },
        "request title naming another tool is ignored",
      );
    }),
  );

  // Code review blocker on 570d970016: under read-only + never this spoof was allowed where the
  // adapter had denied it.
  live("keeps denying a title-only `other` call for a read-only persona", () =>
    Effect.gen(function* () {
      const turn = yield* openTurn(PERSONA);
      const denied = { _tag: "selected", optionId: REJECT_ONCE.optionId } as const;
      const titled = {
        toolCallId: "persona-titled",
        title: "mcp__t3-code__propose_crew",
        kind: "other",
      } as const;
      assert.deepEqual(yield* turn.permit(titled), denied, "no prior state");
      yield* turn.feed({ sessionUpdate: "tool_call", ...titled, status: "pending" });
      assert.deepEqual(yield* turn.permit(titled), denied, "title also in state");
    }),
  );

  // A child session (for example a provider subagent) must not borrow the root session's proof
  // by reusing one of its toolCallIds.
  live("gives a child-session request reusing a root call id the adapter's own verdict", () =>
    Effect.gen(function* () {
      const turn = yield* openTurn(APPROVAL_REQUIRED);
      const root = codexAcpCall("root-propose", "propose_crew");
      yield* turn.feed(root);
      const control = yield* turn.permit(
        { ...sparse(root), toolCallId: "child-unrelated" },
        ALL_OPTIONS,
        "child-session-1",
      );
      assert.notDeepEqual(control, { _tag: "selected", optionId: ALLOW_ONCE.optionId });
      assert.deepEqual(
        yield* turn.permit(sparse(root), ALL_OPTIONS, "child-session-1"),
        control,
        "permission",
      );
      assert.isUndefined(yield* turn.elicit("root-propose", "child-session-1"), "elicitation");
      // The root session itself still gets the pre-approval.
      assert.deepEqual(yield* turn.permit(sparse(root)), {
        _tag: "selected",
        optionId: ALLOW_ONCE.optionId,
      });
    }),
  );

  live("leaves an allow_always-only request to the adapter even with valid tagged state", () =>
    Effect.gen(function* () {
      const turn = yield* openTurn(APPROVAL_REQUIRED);
      const update = codexAcpCall("always-only", "propose_crew");
      yield* turn.feed(update);
      assert.deepEqual(yield* turn.permit(sparse(update), [ALLOW_ALWAYS, REJECT_ONCE]), {
        _tag: "asked",
      });
    }),
  );
});
