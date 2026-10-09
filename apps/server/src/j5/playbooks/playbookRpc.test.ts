import { seedPlaybookOwners } from "./testFixtures.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { requiredScopeForRpcMethod } from "../../auth/RpcAuthorization.ts";
import { J5_PLAYBOOK_WS_METHODS } from "@t3tools/contracts/j5";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { stringify } from "yaml";

import { OrchestratorProjectionError } from "../../orchestration-v2/Orchestrator.ts";
import {
  emptyProjection,
  ProjectionStoreThreadNotFoundError,
} from "../../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { runJ5A2AMigrations } from "../a2a/Migrations.ts";
import { makePlaybookStore } from "./PlaybookStore.ts";
import { makePlaybookRpcHandlers, PLAYBOOK_RPC_SCOPES } from "./playbookRpc.ts";

const projectId = ProjectId.make("project:playbook-rpc");
const otherProjectId = ProjectId.make("project:playbook-rpc-other");
const missingProjectId = ProjectId.make("project:playbook-rpc-missing");
const worktreeThread = ThreadId.make("thread:playbook-rpc-worktree");
const rootThread = ThreadId.make("thread:playbook-rpc-root");
const foreignThread = ThreadId.make("thread:playbook-rpc-foreign");
const deletedThread = ThreadId.make("thread:playbook-rpc-deleted");
const missingThread = ThreadId.make("thread:playbook-rpc-missing");
const createdAt = "2026-09-21T09:00:00.000Z";
const TestLayer = Layer.mergeAll(
  NodeSqliteClient.layer({ filename: ":memory:" }),
  NodeServices.layer,
);

const definition = (title: string) => ({
  title,
  description: `Purpose of ${title}.`,
  steps: [{ id: "first", title: "First step", prompt: "Line one\n\nLine three: yes\n" }],
});

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "j5-playbook-rpc-" });
  const projectRoot = path.join(directory, "project");
  const worktree = path.join(directory, "worktree");
  for (const [root, title] of [
    [projectRoot, "Project library"],
    [worktree, "Worktree library"],
  ] as const) {
    yield* fs.makeDirectory(path.join(root, ".j5/playbooks"), { recursive: true });
    yield* fs.writeFileString(
      path.join(root, ".j5/playbooks/demo.yaml"),
      stringify(definition(title)),
    );
  }
  yield* runJ5A2AMigrations();
  yield* seedPlaybookOwners([]);
  const store = yield* makePlaybookStore;
  const projects = Layer.mock(ProjectService)({
    getById: (id) =>
      Effect.succeed(
        id === missingProjectId
          ? Option.none()
          : Option.some({
              id,
              title: "Library project",
              workspaceRoot: projectRoot,
              defaultModelSelection: null,
              scripts: [],
              createdAt,
              updatedAt: createdAt,
              deletedAt: null,
            }),
      ),
  });
  const threads = Layer.mock(ThreadManagementService)({
    getThreadProjection: (threadId) => {
      if (threadId === missingThread) {
        return Effect.fail(
          new OrchestratorProjectionError({
            threadId,
            cause: new ProjectionStoreThreadNotFoundError({ threadId }),
          }),
        );
      }
      return Effect.succeed(
        emptyProjection({
          id: EventId.make(`created:${threadId}`),
          type: "thread.created",
          threadId,
          occurredAt: DateTime.makeUnsafe(createdAt),
          payload: {
            id: threadId,
            projectId: threadId === foreignThread ? otherProjectId : projectId,
            createdBy: "user",
            creationSource: "web",
            title: "Export test",
            providerInstanceId: ProviderInstanceId.make("codex"),
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: threadId === rootThread ? null : worktree,
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
            deletedAt: threadId === deletedThread ? DateTime.makeUnsafe(createdAt) : null,
          },
        }),
      );
    },
  });
  const handlers = yield* makePlaybookRpcHandlers({
    store,
  }).pipe(Effect.provide(Layer.merge(projects, threads)));
  const exportPlaybook = (input: { projectId: ProjectId; threadId?: ThreadId; name: string }) =>
    handlers[J5_PLAYBOOK_WS_METHODS.exportPlaybook](input);
  return { exportPlaybook };
});

it("requires read scope to export a playbook", () => {
  assert.equal(
    requiredScopeForRpcMethod(J5_PLAYBOOK_WS_METHODS.exportPlaybook),
    AuthOrchestrationReadScope,
  );
  assert.equal(
    PLAYBOOK_RPC_SCOPES[J5_PLAYBOOK_WS_METHODS.exportPlaybook],
    AuthOrchestrationReadScope,
  );
});

it.effect("exports the project or thread worktree definition as its stem file", () =>
  Effect.gen(function* () {
    const { exportPlaybook } = yield* fixture;
    const project = yield* exportPlaybook({ projectId, name: "demo" });
    assert.equal(project.fileName, "demo.yaml");
    assert.include(project.yaml, "Project library");
    const worktree = yield* exportPlaybook({ projectId, threadId: worktreeThread, name: "demo" });
    assert.include(worktree.yaml, "Worktree library");
    const root = yield* exportPlaybook({ projectId, threadId: rootThread, name: "demo" });
    assert.include(root.yaml, "Project library");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("rejects missing, foreign, and deleted workspaces and bad names", () =>
  Effect.gen(function* () {
    const { exportPlaybook } = yield* fixture;
    const code = (input: Parameters<typeof exportPlaybook>[0]) =>
      exportPlaybook(input).pipe(
        Effect.flip,
        Effect.map((error) => (error as { code?: string }).code),
      );
    for (const input of [
      { projectId: missingProjectId, name: "demo" },
      { projectId, threadId: foreignThread, name: "demo" },
      { projectId, threadId: deletedThread, name: "demo" },
      { projectId, threadId: missingThread, name: "demo" },
    ])
      assert.equal(yield* code(input), "workspace_not_found");
    assert.equal(yield* code({ projectId, name: "../demo" }), "invalid_name");
    assert.equal(yield* code({ projectId, name: "missing" }), "not_found");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);
