import { seedPersonas, seedPlaybookOwners } from "./testFixtures.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  RunId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import {
  PlaybookDiscovery,
  PlaybookError,
  PlaybookReadResponse,
  PlaybookStepResponse,
} from "@t3tools/contracts/j5";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { Tool } from "effect/ai";
import { stringify } from "yaml";

import { ServerConfig } from "../../config.ts";
import {
  McpInvocationContext,
  type McpThreadInvocationScope,
} from "../../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import { OrchestratorMcpService } from "../../mcp/OrchestratorMcpService.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { emptyProjection } from "../../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import {
  renderWebhookPrompt,
  webhookPromptLiterals,
} from "../../scheduledTasks/webhookTemplate.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { ArchiveAgentService } from "../a2a/ArchiveAgentService.ts";
import { A2ADeliveryWorker } from "../a2a/DeliveryWorker.ts";
import { A2AHomeRegistrar } from "../a2a/HomeRegistrar.ts";
import { A2ALedger } from "../a2a/LedgerService.ts";
import { runJ5A2AMigrations } from "../a2a/Migrations.ts";
import { ParticipantPlacementService } from "../a2a/PlacementService.ts";
import { A2ASendService } from "../a2a/SendService.ts";
import { SpawnCompositionService } from "../a2a/SpawnCompositionService.ts";
import { ThreadRegistration } from "../a2a/ThreadRegistration.ts";
import { J5ToolkitHandlersLive } from "../a2a/mcp/handlers.ts";
import { J5Toolkit } from "../a2a/mcp/tools.ts";
import { layer as agentCrewInstanceLayer } from "../a2a/AgentCrewInstanceService.ts";
import { layer as playbookCrewRelayLayer } from "./PlaybookCrewRelay.ts";
import { PlaybookStore } from "./PlaybookStore.ts";
import { makePlaybookStoreForTests } from "./testFixtures.ts";
import type { playbookTools } from "./mcp.ts";

const owner = ThreadId.make("thread:playbook-mcp:worktree");
const rootOwner = ThreadId.make("thread:playbook-mcp:project-root");
const projectId = ProjectId.make("project:playbook-mcp");
const createdAt = "2026-09-21T09:00:00.000Z";
const decodeStep = Schema.decodeUnknownEffect(PlaybookStepResponse);
const decodeFailure = Schema.decodeUnknownEffect(PlaybookError);
// A missing capability is refused by the playbook tool for a read and by the access declaration
// for a run tool; both say `capability_denied`.
const decodeFailureCode = Schema.decodeUnknownEffect(Schema.Struct({ code: Schema.String }));
const decodeListed = Schema.decodeUnknownEffect(PlaybookDiscovery);
const decodeRead = Schema.decodeUnknownEffect(PlaybookReadResponse);
type PlaybookToolName = (typeof playbookTools)[number]["name"];
const scopeFor = (
  threadId = owner,
  providerSessionId = "session:first",
): McpThreadInvocationScope => ({
  environmentId: EnvironmentId.make("environment:playbook-mcp"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
  requestNamespace: providerSessionId,
  thread: { threadId, providerSessionId, providerInstanceId: ProviderInstanceId.make("codex") },
  client: undefined,
});
const sample = (title: string) => ({
  title,
  description: "Build a two-word report while the agent controls progress.",
  steps: [
    { id: "research", title: "Research", prompt: "Record ALPHA." },
    { id: "implement", title: "Implement", prompt: "Append BETA to your notes." },
    { id: "review", title: "Review", prompt: "Report ALPHA BETA." },
  ],
});

const kickoffRecords = (
  threadId: ThreadId,
  text = "Check current work.",
  scheduled?: { readonly scheduledTaskPrompt?: string },
) => {
  const time = DateTime.makeUnsafe(createdAt);
  const shell = liveThreadShell(threadId);
  const runId = RunId.make("run:mcp-test");
  const messageId = MessageId.make("message:launch");
  const run: OrchestrationV2Run = {
    id: runId,
    ordinal: 1,
    status: "running",
    threadId,
    providerInstanceId: shell.providerInstanceId,
    modelSelection: shell.modelSelection,
    providerThreadId: null,
    userMessageId: messageId,
    rootNodeId: null,
    activeAttemptId: null,
    requestedAt: time,
    startedAt: time,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const message: OrchestrationV2ConversationMessage = {
    id: messageId,
    threadId,
    runId,
    nodeId: null,
    role: "user",
    text,
    attachments: [],
    streaming: false,
    createdBy: "user",
    creationSource: "web",
    createdAt: time,
    updatedAt: time,
    ...(scheduled === undefined
      ? {}
      : { scheduledTaskId: ScheduledTaskId.make("weekly"), ...scheduled }),
  };
  return { runs: [run] as const, messages: [message] as const };
};
const makeFixture = (
  shell: (threadId: ThreadId) => ReturnType<typeof liveThreadShell> = liveThreadShell,
  runRecords: (threadId: ThreadId) => {
    readonly runs: ReadonlyArray<OrchestrationV2Run>;
    readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  } = (threadId) => kickoffRecords(threadId),
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "j5-playbook-mcp-" });
    const projectRoot = path.join(directory, "project");
    const worktree = path.join(directory, "worktree");
    for (const [root, title] of [
      [projectRoot, "Project playbook"],
      [worktree, "Worktree playbook"],
    ] as const) {
      yield* fs.makeDirectory(path.join(root, ".j5/playbooks"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, ".j5/playbooks/demo.yaml"),
        stringify(sample(title)),
      );
    }
    yield* runJ5A2AMigrations();
    yield* seedPlaybookOwners([owner, rootOwner]);
    const store = yield* makePlaybookStoreForTests;
    const services = Layer.mergeAll(
      Layer.succeed(PlaybookStore, store),
      Layer.mock(ThreadManagementService)({
        // The access gate reads the calling thread before each tool.
        getThreadShell: (threadId) => Effect.succeed(shell(threadId)),
        getThreadRecords: (threadId) =>
          Effect.succeed({
            ...emptyProjection({
              id: EventId.make(`created:${threadId}`),
              type: "thread.created",
              threadId,
              occurredAt: DateTime.makeUnsafe(createdAt),
              payload: {
                id: threadId,
                projectId,
                createdBy: "user",
                creationSource: "web",
                title: "Playbook test",
                providerInstanceId: ProviderInstanceId.make("codex"),
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex"),
                  model: "test-model",
                },
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: threadId === owner ? worktree : null,
                activeProviderThreadId: null,
                lineage: {
                  parentThreadId: null,
                  relationshipToParent: null,
                  rootThreadId: threadId,
                },
                forkedFrom: null,
                createdAt: DateTime.makeUnsafe(createdAt),
                updatedAt: DateTime.makeUnsafe(createdAt),
                archivedAt: null,
                settledOverride: null,
                settledAt: null,
                snoozedUntil: null,
                snoozedAt: null,
                lastVisitedAt: null,
                deletedAt: null,
              },
            }),
            ...runRecords(threadId),
          }),
      }),
      Layer.mock(ProjectService)({
        getById: () =>
          Effect.succeedSome({
            id: projectId,
            title: "Project",
            workspaceRoot: projectRoot,
            defaultModelSelection: null,
            scripts: [],
            createdAt,
            updatedAt: createdAt,
            deletedAt: null,
          }),
      }),
      Layer.mock(OrchestratorV2)({}),
      Layer.mock(OrchestratorMcpService)({}),
      Layer.mock(A2ADeliveryWorker)({}),
      Layer.mock(A2AHomeRegistrar)({}),
      Layer.mock(A2ALedger)({}),
      Layer.mock(ParticipantPlacementService)({}),
      Layer.mock(A2ASendService)({}),
      Layer.mock(SpawnCompositionService)({}),
      Layer.mock(ArchiveAgentService)({}),
      Layer.mock(ThreadRegistration)({}),
      Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
    );
    const dependencies = playbookCrewRelayLayer.pipe(
      Layer.provideMerge(agentCrewInstanceLayer),
      Layer.provideMerge(services),
    );
    const toolkit = yield* J5Toolkit.pipe(
      Effect.provide(J5ToolkitHandlersLive.pipe(Layer.provide(dependencies))),
    );
    const call = <Name extends PlaybookToolName>(
      name: Name,
      input: Tool.Parameters<(typeof J5Toolkit.tools)[Name]>,
      scope = scopeFor(),
    ) =>
      toolkit
        .handle(name, input)
        .pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provide(dependencies),
          Effect.provideService(McpInvocationContext, scope),
        );
    return { call, fs, path, worktree, projectRoot };
  });
const fixture = makeFixture();
const stampActiveTurn = Effect.fn("test.stampActiveTurn")(function* (
  source: "owner" | "collaborator" | "scheduled" | "unattributed" | "agent" | "revoked" | "steered",
) {
  const sql = yield* SqlClient.SqlClient;
  const runId = liveThreadShell(owner).activeRunId!;
  const commandId = "command:active-turn";
  const messageId = "message:active-turn";
  const person = "human:active-turn";
  yield* sql`
    INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
    VALUES (${runId}, ${owner}, 1, 'codex', 'running', ${createdAt},
      json_object('userMessageId', ${messageId}))
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_messages
      (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
    VALUES (${messageId}, ${owner}, ${runId}, 'user', 0, ${createdAt}, ${createdAt},
      json_object(
        'createdBy', ${source === "agent" ? "agent" : "user"},
        'scheduledTaskId', ${source === "scheduled" ? "task:active" : null},
        'senderThreadId', ${source === "agent" ? "thread:sender" : null}
      ))
  `;
  yield* sql`
    INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version,
      event_type, occurred_at, command_id, actor_kind, payload_json, metadata_json)
    VALUES ('event:active-turn', 'thread', ${owner}, 1, 'message.updated', ${createdAt},
      ${commandId}, 'user', json_object('id', ${messageId}), '{}')
  `;
  if (source === "steered") {
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('message:steer', ${owner}, ${runId}, 'user', 0, ${createdAt}, ${createdAt},
        '{"createdBy":"user"}')
    `;
  }
  if (source === "unattributed") return;
  yield* sql`
    INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at)
    VALUES (${person}, 0, ${createdAt})
  `;
  yield* sql`
    INSERT INTO j5_a2a_person_level (person_id, scope_kind, scope_id, level, created_at, updated_at)
    VALUES (${person}, 'server', '', ${source === "collaborator" || source === "revoked" ? "collaborator" : "owner"},
      ${createdAt}, ${createdAt})
  `;
  yield* sql`
    INSERT INTO j5_human_message_command (command_id, message_id, person_id, settings_write)
    VALUES (${commandId}, ${messageId}, ${person}, ${source === "collaborator" ? 0 : 1})
  `;
});
const TestLayer = Layer.mergeAll(
  NodeSqliteClient.layer({ filename: ":memory:" }),
  Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
);

it.effect("runs a scripted three-step sample through the real J5Toolkit handlers", () =>
  Effect.gen(function* () {
    const { call } = yield* fixture;
    const first = yield* call("j5_playbook_start", { name: "demo", client_request_id: "start-a" });
    assert.isFalse(first.isFailure);
    const run = yield* decodeStep(first.result);
    assert.equal(run.currentStep?.prompt, "Record ALPHA.");
    const notes = ["ALPHA"];
    const recovered = yield* call(
      "j5_playbook_current",
      {},
      scopeFor(owner, "session:after-compaction"),
    );
    assert.equal((yield* decodeStep(recovered.result)).runId, run.runId);

    const nextInput = { runId: run.runId, expectedStepId: "research", client_request_id: "next-1" };
    const second = yield* call("j5_playbook_next", nextInput);
    assert.equal(
      (yield* decodeStep(second.result)).currentStep?.prompt,
      "Append BETA to your notes.",
    );
    notes.push("BETA");
    const back = yield* call("j5_playbook_back", {
      runId: run.runId,
      expectedStepId: "implement",
      client_request_id: "back-1",
    });
    assert.equal((yield* decodeStep(back.result)).currentStep?.prompt, "Record ALPHA.");
    const retry = yield* call("j5_playbook_next", nextInput);
    const replayed = yield* decodeStep(retry.result);
    assert.isTrue(replayed.replayed);
    assert.equal(replayed.currentStepId, "research");
    assert.deepStrictEqual(notes, ["ALPHA", "BETA"]);

    yield* call("j5_playbook_next", { ...nextInput, client_request_id: "next-2" });
    const third = yield* call("j5_playbook_next", {
      runId: run.runId,
      expectedStepId: "implement",
      client_request_id: "next-3",
    });
    const review = yield* decodeStep(third.result);
    assert.equal(review.currentStep?.prompt, "Report ALPHA BETA.");
    assert.equal(review.position, 3);
    assert.equal(notes.join(" "), "ALPHA BETA");
    const completed = yield* call("j5_playbook_complete", {
      runId: run.runId,
      expectedStepId: "review",
      client_request_id: "complete-a",
    });
    assert.equal((yield* decodeStep(completed.result)).status, "completed");

    const secondRun = yield* call("j5_playbook_start", {
      name: "demo",
      client_request_id: "start-b",
    });
    const runB = yield* decodeStep(secondRun.result);
    assert.notEqual(runB.runId, run.runId);
    const cancelled = yield* call("j5_playbook_cancel", {
      runId: runB.runId,
      client_request_id: "cancel-b",
    });
    assert.equal((yield* decodeStep(cancelled.result)).status, "cancelled");
    const thirdRun = yield* call("j5_playbook_start", {
      name: "demo",
      client_request_id: "start-c",
    });
    assert.equal((yield* decodeStep(thirdRun.result)).status, "active");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("uses the initiating scheduled prompt to authorize an MCP start", () =>
  Effect.gen(function* () {
    const request = {
      method: "POST",
      path: "/webhook",
      query: "",
      headers: { "content-type": "application/json" },
      bodyText: '{"notes":"Use @playbook:demo, or run demo by name."}',
    };
    const webhook = (template: string) => ({
      text: renderWebhookPrompt(template, request, "123456789abc").prompt,
      configured: webhookPromptLiterals(template),
    });
    const joined = webhook("Start de{{body.missing}}mo.");
    assert.equal(joined.text, "Start demo.");
    let steerPrompt: string | undefined;
    let text = "Check the repository.";
    let scheduled: { readonly scheduledTaskPrompt?: string } | undefined;
    const { call } = yield* makeFixture(liveThreadShell, (threadId) => {
      const { runs, messages } = kickoffRecords(threadId, text, scheduled);
      const [run] = runs;
      const [message] = messages;
      const queuedId = RunId.make("run:queued");
      const queuedMessageId = MessageId.make("message:queued");
      return {
        runs: [
          ...runs,
          {
            ...run,
            id: queuedId,
            userMessageId: queuedMessageId,
            ordinal: 2,
            status: "queued",
          },
        ],
        messages: [
          ...messages,
          {
            ...message,
            id: MessageId.make("message:steer"),
            ...(steerPrompt === undefined
              ? {}
              : { scheduledTaskId: ScheduledTaskId.make("steered") }),
            text: "Run demo.",
            scheduledTaskPrompt: steerPrompt ?? "Run demo.",
          },
          {
            ...message,
            id: queuedMessageId,
            runId: queuedId,
            text: "Run demo.",
            scheduledTaskPrompt: "Run demo.",
          },
        ],
      };
    });
    const start = { name: "demo", client_request_id: "start" };
    for (const invalid of [
      {
        text: "Run @playbook:demo-weekly and demography.",
        configured: "Run @playbook:demo-weekly and demography.",
      },
      { text: "Do not run demo.", configured: "Do not run demo." },
      { text: "Never use @playbook:demo.", configured: "Never use @playbook:demo." },
      { text: "Explain how to run demo.", configured: "Explain how to run demo." },
      { text: "Demo the result.", configured: "Demo the result." },
      { text: "Run demo.sh.", configured: "Run demo.sh." },
      { text: "Run @persona:demo.", configured: "Run @persona:demo." },
      webhook("Process this request: {{body.notes}}"),
      { text: "Example", configured: "Example:\n```text\nRun demo.\n```" },
      joined,
      { text: "Start demo.", configured: undefined },
    ]) {
      text = invalid.text;
      scheduled =
        invalid.configured === undefined ? {} : { scheduledTaskPrompt: invalid.configured };
      const result = yield* call("j5_playbook_start", start);
      assert.isTrue(result.isFailure);
      const failure = yield* decodeFailure(result.result);
      assert.equal(failure.code, "scheduled_playbook_not_named");
      assert.include(failure.message, "demo");
    }

    scheduled = undefined;
    steerPrompt = "Demo this change.";
    const steered = yield* call("j5_playbook_start", start);
    assert.equal((yield* decodeFailure(steered.result)).code, "scheduled_playbook_not_named");
    const revise = yield* call("j5_playbook_revise", {
      runId: "example",
      expectedStepId: "research",
      steps: sample("Demo").steps,
      basis: "asked",
      client_request_id: "revision",
    });
    assert.equal((yield* decodeFailure(revise.result)).code, "scheduled_playbook_revision");
    steerPrompt = "Use the demo playbook.";
    for (const valid of [
      webhook("Start @playbook:demo. Notes: {{body.notes}}"),
      { text: "Run demo without editing files.", configured: "Run demo without editing files." },
      { text: "Run `demo`.", configured: "Run `demo`." },
      // A queued prompt can be edited before delivery. Authorization follows its dispatch snapshot.
      { text: "Queued text edited since dispatch.", configured: "Run demo." },
      { text: "Check the repository.", configured: undefined },
    ]) {
      text = valid.text;
      scheduled =
        valid.configured === undefined ? undefined : { scheduledTaskPrompt: valid.configured };
      const result = yield* call("j5_playbook_start", start);
      assert.isFalse(result.isFailure);
      const { runId } = yield* decodeStep(result.result);
      yield* call("j5_playbook_cancel", { runId, client_request_id: `cancel:${runId}` });
      start.client_request_id = `start:${runId}`;
    }
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("enforces authenticated peer provenance and refuses an unverified remote origin", () =>
  Effect.gen(function* () {
    let origin: OrchestrationV2ConversationMessage["playbookOrigin"] = { kind: "unverified" };
    const { call } = yield* makeFixture(liveThreadShell, (threadId) => {
      const {
        runs,
        messages: [message],
      } = kickoffRecords(threadId);
      return { runs, messages: [{ ...message, createdBy: "agent", playbookOrigin: origin }] };
    });
    const start = { name: "demo", client_request_id: "remote" };
    assert.equal(
      (yield* decodeFailure((yield* call("j5_playbook_start", start)).result)).code,
      "playbook_turn_unavailable",
    );
    origin = undefined;
    assert.equal(
      (yield* decodeFailure((yield* call("j5_playbook_start", start)).result)).code,
      "playbook_turn_unavailable",
    );
    origin = { kind: "scheduled", names: ["other"] };
    assert.equal(
      (yield* decodeFailure((yield* call("j5_playbook_start", start)).result)).code,
      "scheduled_playbook_not_named",
    );
    for (const verified of [
      { kind: "scheduled", names: ["demo"] },
      { kind: "unscheduled" },
    ] as const) {
      origin = verified;
      const result = yield* call("j5_playbook_start", {
        ...start,
        client_request_id: verified.kind,
      });
      assert.isFalse(result.isFailure);
      const { runId } = yield* decodeStep(result.result);
      yield* call("j5_playbook_cancel", { runId, client_request_id: "cancel:" + runId });
    }
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect(
  "checks the sending run of a child or a peer message even after the parent moves on",
  () =>
    Effect.gen(function* () {
      const parent = ThreadId.make("thread:scheduled-parent");
      const parentRunId = RunId.make("run:scheduled-parent");
      let configured = "Review open PRs.";
      let human = false;
      const { call } = yield* makeFixture(liveThreadShell, (threadId) => {
        const {
          runs: [run],
          messages: [message],
        } = kickoffRecords(threadId);
        if (threadId === parent)
          return {
            runs: [{ ...run, id: parentRunId, status: "completed" }],
            messages: [
              {
                ...message,
                runId: parentRunId,
                scheduledTaskId: ScheduledTaskId.make("review"),
                scheduledTaskPrompt: configured,
              },
            ],
          };
        return {
          runs: [run],
          messages: [
            human
              ? message
              : {
                  ...message,
                  createdBy: "agent",
                  senderThreadId: parent,
                  senderRunId: parentRunId,
                },
          ],
        };
      });
      const start = { name: "demo", client_request_id: "child" };
      assert.equal(
        (yield* decodeFailure((yield* call("j5_playbook_start", start)).result)).code,
        "scheduled_playbook_not_named",
      );
      configured = "Run demo.";
      const named = yield* call("j5_playbook_start", start);
      assert.isFalse(named.isFailure);
      const { runId } = yield* decodeStep(named.result);
      yield* call("j5_playbook_cancel", { runId, client_request_id: "cancel" });
      human = true;
      configured = "Review open PRs.";
      assert.isFalse(
        (yield* call("j5_playbook_start", { ...start, client_request_id: "human" })).isFailure,
      );
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("discovers and starts from the thread worktree, falling back to its project root", () =>
  Effect.gen(function* () {
    const { call, path, worktree, projectRoot } = yield* fixture;
    const decodeDiscovery = Schema.decodeUnknownEffect(PlaybookDiscovery);
    const worktreeList = yield* call("j5_playbook_list", {});
    const projectList = yield* call("j5_playbook_list", {}, scopeFor(rootOwner));
    assert.equal(
      (yield* decodeDiscovery(worktreeList.result)).playbooks[0]?.title,
      "Worktree playbook",
    );
    assert.equal(
      (yield* decodeDiscovery(projectList.result)).playbooks[0]?.title,
      "Project playbook",
    );
    const worktreeRun = yield* call("j5_playbook_start", {
      name: "demo",
      client_request_id: "start",
    });
    const projectRun = yield* call(
      "j5_playbook_start",
      { name: "demo", client_request_id: "start" },
      scopeFor(rootOwner),
    );
    assert.equal(
      (yield* decodeStep(worktreeRun.result)).definitionPath,
      path.join(worktree, ".j5/playbooks/demo.yaml"),
    );
    assert.equal(
      (yield* decodeStep(projectRun.result)).definitionPath,
      path.join(projectRoot, ".j5/playbooks/demo.yaml"),
    );
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("denies a different owner and every tool when orchestration capability is absent", () =>
  Effect.gen(function* () {
    const { call } = yield* fixture;
    const started = yield* call("j5_playbook_start", { name: "demo", client_request_id: "start" });
    const run = yield* decodeStep(started.result);
    const movement = { runId: run.runId, expectedStepId: "research", client_request_id: "denied" };
    for (const scope of [scopeFor(rootOwner), { ...scopeFor(), capabilities: new Set<never>() }]) {
      const expected = scope.thread.threadId === rootOwner ? "not_owner" : "capability_denied";
      const responses = [
        yield* call("j5_playbook_current", { runId: run.runId }, scope),
        yield* call("j5_playbook_next", movement, scope),
        yield* call("j5_playbook_back", movement, scope),
        yield* call("j5_playbook_complete", movement, scope),
        yield* call("j5_playbook_cancel", { runId: run.runId, client_request_id: "denied" }, scope),
      ];
      for (const response of responses) {
        assert.isTrue(response.isFailure);
        assert.equal((yield* decodeFailureCode(response.result)).code, expected);
      }
    }
    const deniedScope = { ...scopeFor(), capabilities: new Set<never>() };
    const deniedDiscovery = yield* call("j5_playbook_list", {}, deniedScope);
    const deniedStart = yield* call(
      "j5_playbook_start",
      { name: "demo", client_request_id: "denied-start" },
      deniedScope,
    );
    assert.equal((yield* decodeFailure(deniedDiscovery.result)).code, "capability_denied");
    assert.equal((yield* decodeFailureCode(deniedStart.result)).code, "capability_denied");
    const current = yield* call("j5_playbook_current", { runId: run.runId });
    assert.equal((yield* decodeStep(current.result)).currentStepId, "research");
    assert.equal((yield* decodeStep(current.result)).status, "active");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("keeps the saved step after library edits and deletion through the toolkit", () =>
  Effect.gen(function* () {
    const { call, fs, path, worktree } = yield* fixture;
    const started = yield* call("j5_playbook_start", { name: "demo", client_request_id: "start" });
    const run = yield* decodeStep(started.result);
    const file = path.join(worktree, ".j5/playbooks/demo.yaml");
    yield* fs.writeFileString(
      file,
      stringify({ ...sample("Edited playbook"), steps: sample("Edited").steps.slice(1) }),
    );
    const current = yield* call("j5_playbook_current", { runId: run.runId });
    assert.equal((yield* decodeStep(current.result)).currentStepId, "research");
    yield* fs.remove(file);
    const replayed = yield* call("j5_playbook_start", { name: "demo", client_request_id: "start" });
    assert.equal((yield* decodeStep(replayed.result)).runId, run.runId);
    const cancelled = yield* call("j5_playbook_cancel", {
      runId: run.runId,
      client_request_id: "cancel",
    });
    assert.isFalse(cancelled.isFailure);
    assert.equal((yield* decodeStep(cancelled.result)).status, "cancelled");
    const after = yield* call("j5_playbook_current", {});
    assert.isFalse(after.isFailure);
    assert.equal((yield* decodeStep(after.result)).status, "cancelled");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("reads step personas and warnings through the toolkit and still starts the run", () =>
  Effect.gen(function* () {
    const { call, fs, path, worktree } = yield* fixture;
    yield* seedPersonas([{ id: "planner", enabled: false }]);
    const staffed = sample("Staffed playbook");
    yield* fs.writeFileString(
      path.join(worktree, ".j5/playbooks/demo.yaml"),
      stringify({
        ...staffed,
        steps: staffed.steps.map((step, index) =>
          index === 0 ? { ...step, persona: "planner" } : step,
        ),
      }),
    );
    const warning = {
      code: "persona_disabled" as const,
      stepId: "research",
      persona: "planner",
      message: `Step "research" has a required persona disabled in this environment: "planner".`,
    };
    const listed = yield* decodeListed((yield* call("j5_playbook_list", {})).result);
    assert.isNull(listed.playbooks[0]?.issue);
    assert.deepStrictEqual(listed.playbooks[0]?.warnings, [warning]);
    assert.equal(listed.playbooks[0]?.steps[0]?.persona, "planner");

    const read = yield* call("j5_playbook_read", { name: "demo" });
    assert.isFalse(read.isFailure);
    const definition = yield* decodeRead(read.result);
    assert.deepStrictEqual(definition.warnings, [warning]);
    assert.equal(definition.steps[0]?.persona, "planner");
    assert.equal(definition.steps[1]?.prompt, "Append BETA to your notes.");
    const absent = yield* call("j5_playbook_read", { name: "absent" });
    assert.isTrue(absent.isFailure);
    assert.equal((yield* decodeFailure(absent.result)).code, "not_found");
    const denied = yield* call(
      "j5_playbook_read",
      { name: "demo" },
      { ...scopeFor(), capabilities: new Set<never>() },
    );
    assert.equal((yield* decodeFailure(denied.result)).code, "capability_denied");

    const started = yield* call("j5_playbook_start", { name: "demo", client_request_id: "start" });
    assert.isFalse(started.isFailure);
    const blocked = yield* decodeStep(started.result);
    assert.equal(blocked.status, "active");
    assert.equal(blocked.delivery?.state, "blocked");
    assert.isNull(blocked.currentStep);
    assert.equal(blocked.requiredPersonas?.[0]?.status, "unavailable");
    const current = yield* call("j5_playbook_current", {});
    assert.isFalse(current.isFailure);
    assert.deepEqual(yield* decodeStep(current.result), blocked);
    const refused = yield* call("j5_playbook_next", {
      runId: blocked.runId,
      expectedStepId: blocked.currentStepId,
      client_request_id: "advance-unassigned",
    });
    assert.equal((yield* decodeFailure(refused.result)).code, "required_persona_mismatch");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "j5-playbook-mcp-personas-" }).pipe(
        Layer.provideMerge(TestLayer),
      ),
    ),
  ),
);

it.effect(
  "saves a shared playbook through the real MCP tool and reads it from root and worktree callers",
  () =>
    Effect.gen(function* () {
      const { call, fs, path, projectRoot, worktree } = yield* fixture;
      yield* stampActiveTurn("owner");
      const saved = yield* call("j5_playbook_save", {
        name: "shared",
        yaml: stringify(sample("Shared playbook")),
      });
      assert.isFalse(saved.isFailure);
      for (const scope of [scopeFor(), scopeFor(rootOwner)]) {
        const read = yield* decodeRead(
          (yield* call("j5_playbook_read", { name: "shared" }, scope)).result,
        );
        assert.equal(read.title, "Shared playbook");
        const listing = yield* decodeListed((yield* call("j5_playbook_list", {}, scope)).result);
        assert.equal(
          listing.playbooks.find((entry) => entry.name === "shared")?.source?.kind,
          "environment",
        );
      }
      assert.isFalse(yield* fs.exists(path.join(projectRoot, ".j5/playbooks/shared.yaml")));
      assert.isFalse(yield* fs.exists(path.join(worktree, ".j5/playbooks/shared.yaml")));
      const denied = yield* call(
        "j5_playbook_save",
        { name: "denied", yaml: stringify(sample("Denied")) },
        { ...scopeFor(), capabilities: new Set() },
      );
      assert.isTrue(denied.isFailure);
      assert.equal((yield* decodeFailureCode(denied.result)).code, "capability_denied");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "j5-playbook-mcp-save-" }).pipe(
          Layer.provideMerge(TestLayer),
        ),
      ),
    ),
);

it.effect.each([
  "collaborator",
  "scheduled",
  "unattributed",
  "agent",
  "revoked",
  "steered",
] as const)("refuses a library save during a %s turn", (source) =>
  Effect.gen(function* () {
    const { call, fs, path } = yield* fixture;
    yield* stampActiveTurn(source);
    const result = yield* call("j5_playbook_save", {
      name: "refused",
      yaml: stringify(sample("Refused")),
    });
    assert.isTrue(result.isFailure);
    const refusal = yield* decodeFailure(result.result);
    assert.equal(refusal.code, "owner_required");
    assert.include(refusal.message, "Keep the full YAML draft");
    const { stateDir } = yield* ServerConfig;
    assert.isFalse(yield* fs.exists(path.join(stateDir, "playbooks/refused.yaml")));
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "j5-playbook-mcp-refuse-" }).pipe(
        Layer.provideMerge(TestLayer),
      ),
    ),
  ),
);

it.effect("maps stored persona policies before permitting playbook definition writes", () =>
  Effect.gen(function* () {
    const { fs, path } = yield* fixture;
    const { stateDir } = yield* ServerConfig;
    yield* stampActiveTurn("owner");
    const plan = yield* makeFixture((threadId) => ({
      ...liveThreadShell(threadId),
      interactionMode: "plan",
    }));
    const denied = yield* plan.call("j5_playbook_save", {
      name: "denied",
      yaml: stringify(sample("Denied")),
    });
    assert.isTrue(denied.isFailure);
    assert.equal((yield* decodeFailureCode(denied.result)).code, "capability_denied");
    for (const authorityPolicy of [
      "read-only",
      "critic-review",
      "diagnostic",
      "publish-only",
      "future-policy",
    ]) {
      const readOnly = yield* makeFixture((threadId) => ({
        ...liveThreadShell(threadId),
        agentPersonaAssignment: {
          personaId: "reader",
          definitionVersion: 1,
          authorityPolicy,
          resolvedRoute: "primary",
          resolvedDriver: ProviderDriverKind.make("codex"),
          resolvedModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "test-model",
          },
        },
      }));
      assert.isTrue(
        (yield* readOnly.call("j5_playbook_save", {
          name: "denied",
          yaml: stringify(sample("Denied")),
        })).isFailure,
      );
    }
    assert.isFalse(yield* fs.exists(path.join(stateDir, "playbooks/denied.yaml")));
    for (const authorityPolicy of ["workspace-write", "critic-fix", "full-access"]) {
      const writer = yield* makeFixture((threadId) => ({
        ...liveThreadShell(threadId),
        runtimeMode: "auto-accept-edits",
        agentPersonaAssignment: {
          personaId: "playbook-author",
          definitionVersion: 1,
          authorityPolicy,
          resolvedRoute: "primary",
          resolvedDriver: ProviderDriverKind.make("codex"),
          resolvedModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "test-model",
          },
        },
      }));
      assert.isFalse(
        (yield* writer.call("j5_playbook_save", {
          name: `authored-${authorityPolicy}`,
          yaml: stringify(sample("Authored")),
        })).isFailure,
      );
      assert.isTrue(
        yield* fs.exists(path.join(stateDir, `playbooks/authored-${authorityPolicy}.yaml`)),
      );
    }
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "j5-playbook-mcp-write-policy-" }).pipe(
        Layer.provideMerge(TestLayer),
      ),
    ),
  ),
);
