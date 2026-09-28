import { seedPlaybookOwners } from "./testFixtures.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { PlaybookDiscovery, PlaybookError, PlaybookStepResponse } from "@t3tools/contracts/j5";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";
import { stringify } from "yaml";

import { McpInvocationContext, type McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../mcp/OrchestratorMcpService.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { emptyProjection } from "../../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { ArchiveAgentService } from "../a2a/ArchiveAgentService.ts";
import { A2ADeliveryWorker } from "../a2a/DeliveryWorker.ts";
import { A2AHomeRegistrar } from "../a2a/HomeRegistrar.ts";
import { A2ALedger } from "../a2a/LedgerService.ts";
import { runJ5A2AMigrations } from "../a2a/Migrations.ts";
import { ParticipantPlacementService } from "../a2a/PlacementService.ts";
import { A2ASendService } from "../a2a/SendService.ts";
import { SpawnCompositionService } from "../a2a/SpawnCompositionService.ts";
import { SquadronJoinService } from "../a2a/SquadronJoinService.ts";
import { SquadronProjectReferences } from "../a2a/SquadronProjectReferences.ts";
import { J5ToolkitHandlersLive } from "../a2a/mcp/handlers.ts";
import { J5Toolkit } from "../a2a/mcp/tools.ts";
import { makePlaybookStore, PlaybookStore } from "./PlaybookStore.ts";
import type { playbookTools } from "./mcp.ts";

const owner = ThreadId.make("thread:playbook-mcp:worktree");
const rootOwner = ThreadId.make("thread:playbook-mcp:project-root");
const projectId = ProjectId.make("project:playbook-mcp");
const createdAt = "2026-09-21T09:00:00.000Z";
const decodeStep = Schema.decodeUnknownEffect(PlaybookStepResponse);
const decodeFailure = Schema.decodeUnknownEffect(PlaybookError);
type PlaybookToolName = (typeof playbookTools)[number]["name"];
const scopeFor = (threadId = owner, providerSessionId = "session:first"): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:playbook-mcp"),
  threadId,
  providerSessionId,
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
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

const fixture = Effect.gen(function* () {
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
    yield* fs.writeFileString(path.join(root, ".j5/playbooks/demo.yaml"), stringify(sample(title)));
  }
  yield* runJ5A2AMigrations();
  yield* seedPlaybookOwners([owner, rootOwner]);
  const store = yield* makePlaybookStore;
  const dependencies = Layer.mergeAll(
    Layer.succeed(PlaybookStore, store),
    Layer.mock(ThreadManagementService)({
      getThreadProjection: (threadId) =>
        Effect.succeed(
          emptyProjection({
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
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: threadId === owner ? worktree : null,
              activeProviderThreadId: null,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
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
        ),
    }),
    Layer.mock(ProjectService)({
      getById: () =>
        Effect.succeed(
          Option.some({
            id: projectId,
            title: "Project",
            workspaceRoot: projectRoot,
            defaultModelSelection: null,
            scripts: [],
            createdAt,
            updatedAt: createdAt,
            deletedAt: null,
          }),
        ),
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
    Layer.mock(SquadronJoinService)({}),
    Layer.mock(SquadronProjectReferences)({}),
    NodeServices.layer,
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
const TestLayer = Layer.mergeAll(
  NodeSqliteClient.layer({ filename: ":memory:" }),
  NodeServices.layer,
);

it.effect("runs a scripted three-step sample through the real J5Toolkit handlers", () =>
  Effect.gen(function* () {
    const { call } = yield* fixture;
    const first = yield* call("playbook_start", { name: "demo", client_request_id: "start-a" });
    assert.isFalse(first.isFailure);
    const run = yield* decodeStep(first.result);
    assert.equal(run.currentStep?.prompt, "Record ALPHA.");
    const notes = ["ALPHA"];
    const recovered = yield* call(
      "playbook_current",
      {},
      scopeFor(owner, "session:after-compaction"),
    );
    assert.equal((yield* decodeStep(recovered.result)).runId, run.runId);

    const nextInput = { runId: run.runId, expectedStepId: "research", client_request_id: "next-1" };
    const second = yield* call("playbook_next", nextInput);
    assert.equal(
      (yield* decodeStep(second.result)).currentStep?.prompt,
      "Append BETA to your notes.",
    );
    notes.push("BETA");
    const back = yield* call("playbook_back", {
      runId: run.runId,
      expectedStepId: "implement",
      client_request_id: "back-1",
    });
    assert.equal((yield* decodeStep(back.result)).currentStep?.prompt, "Record ALPHA.");
    const retry = yield* call("playbook_next", nextInput);
    const replayed = yield* decodeStep(retry.result);
    assert.isTrue(replayed.replayed);
    assert.equal(replayed.currentStepId, "research");
    assert.deepStrictEqual(notes, ["ALPHA", "BETA"]);

    yield* call("playbook_next", { ...nextInput, client_request_id: "next-2" });
    const third = yield* call("playbook_next", {
      runId: run.runId,
      expectedStepId: "implement",
      client_request_id: "next-3",
    });
    const review = yield* decodeStep(third.result);
    assert.equal(review.currentStep?.prompt, "Report ALPHA BETA.");
    assert.equal(review.position, 3);
    assert.equal(notes.join(" "), "ALPHA BETA");
    const completed = yield* call("playbook_complete", {
      runId: run.runId,
      expectedStepId: "review",
      client_request_id: "complete-a",
    });
    assert.equal((yield* decodeStep(completed.result)).status, "completed");

    const secondRun = yield* call("playbook_start", { name: "demo", client_request_id: "start-b" });
    const runB = yield* decodeStep(secondRun.result);
    assert.notEqual(runB.runId, run.runId);
    const cancelled = yield* call("playbook_cancel", {
      runId: runB.runId,
      client_request_id: "cancel-b",
    });
    assert.equal((yield* decodeStep(cancelled.result)).status, "cancelled");
    const thirdRun = yield* call("playbook_start", { name: "demo", client_request_id: "start-c" });
    assert.equal((yield* decodeStep(thirdRun.result)).status, "active");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("discovers and starts from the thread worktree, falling back to its project root", () =>
  Effect.gen(function* () {
    const { call, path, worktree, projectRoot } = yield* fixture;
    const decodeDiscovery = Schema.decodeUnknownEffect(PlaybookDiscovery);
    const worktreeList = yield* call("playbook_list", {});
    const projectList = yield* call("playbook_list", {}, scopeFor(rootOwner));
    assert.equal(
      (yield* decodeDiscovery(worktreeList.result)).playbooks[0]?.title,
      "Worktree playbook",
    );
    assert.equal(
      (yield* decodeDiscovery(projectList.result)).playbooks[0]?.title,
      "Project playbook",
    );
    const worktreeRun = yield* call("playbook_start", { name: "demo", client_request_id: "start" });
    const projectRun = yield* call(
      "playbook_start",
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
    const started = yield* call("playbook_start", { name: "demo", client_request_id: "start" });
    const run = yield* decodeStep(started.result);
    const movement = { runId: run.runId, expectedStepId: "research", client_request_id: "denied" };
    for (const scope of [scopeFor(rootOwner), { ...scopeFor(), capabilities: new Set<never>() }]) {
      const expected = scope.threadId === rootOwner ? "not_owner" : "capability_denied";
      const responses = [
        yield* call("playbook_current", { runId: run.runId }, scope),
        yield* call("playbook_next", movement, scope),
        yield* call("playbook_back", movement, scope),
        yield* call("playbook_complete", movement, scope),
        yield* call("playbook_reselect", { ...movement, stepId: "review" }, scope),
        yield* call("playbook_cancel", { runId: run.runId, client_request_id: "denied" }, scope),
      ];
      for (const response of responses) {
        assert.isTrue(response.isFailure);
        assert.equal((yield* decodeFailure(response.result)).code, expected);
      }
    }
    const deniedScope = { ...scopeFor(), capabilities: new Set<never>() };
    const deniedDiscovery = yield* call("playbook_list", {}, deniedScope);
    const deniedStart = yield* call(
      "playbook_start",
      { name: "demo", client_request_id: "denied-start" },
      deniedScope,
    );
    assert.equal((yield* decodeFailure(deniedDiscovery.result)).code, "capability_denied");
    assert.equal((yield* decodeFailure(deniedStart.result)).code, "capability_denied");
    const current = yield* call("playbook_current", { runId: run.runId });
    assert.equal((yield* decodeStep(current.result)).currentStepId, "research");
    assert.equal((yield* decodeStep(current.result)).status, "active");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("returns actionable live-file errors and recovers or cancels through the toolkit", () =>
  Effect.gen(function* () {
    const { call, fs, path, worktree } = yield* fixture;
    const started = yield* call("playbook_start", { name: "demo", client_request_id: "start" });
    const run = yield* decodeStep(started.result);
    const file = path.join(worktree, ".j5/playbooks/demo.yaml");
    yield* fs.writeFileString(
      file,
      stringify({ ...sample("Edited playbook"), steps: sample("Edited").steps.slice(1) }),
    );
    const missing = yield* call("playbook_current", { runId: run.runId });
    assert.isTrue(missing.isFailure);
    assert.deepStrictEqual((yield* decodeFailure(missing.result)).availableStepIds, [
      "implement",
      "review",
    ]);
    const recovered = yield* call("playbook_reselect", {
      runId: run.runId,
      expectedStepId: "research",
      stepId: "implement",
      client_request_id: "recover",
    });
    assert.equal(
      (yield* decodeStep(recovered.result)).currentStep?.prompt,
      "Append BETA to your notes.",
    );
    yield* fs.remove(file);
    const invalid = yield* call("playbook_current", { runId: run.runId });
    assert.equal((yield* decodeFailure(invalid.result)).code, "invalid_definition");
    const cancelled = yield* call("playbook_cancel", {
      runId: run.runId,
      client_request_id: "cancel",
    });
    assert.isFalse(cancelled.isFailure);
    assert.equal((yield* decodeStep(cancelled.result)).status, "cancelled");
    const after = yield* call("playbook_current", {});
    assert.isFalse(after.isFailure);
    assert.equal((yield* decodeStep(after.result)).status, "cancelled");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);
