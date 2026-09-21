import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
  EnvironmentScopeRequiredError,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { PLAYBOOK_LIBRARY_PATH, PlaybookLibraryResponse } from "@t3tools/contracts/j5";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { stringify } from "yaml";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { OrchestratorProjectionError } from "../../orchestration-v2/Orchestrator.ts";
import {
  emptyProjection,
  ProjectionStoreThreadNotFoundError,
} from "../../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { runJ5A2AMigrations } from "../a2a/Migrations.ts";
import { playbookLibraryHttpRouteLayer } from "./PlaybookLibraryHttp.ts";
import { makePlaybookStore, PlaybookStore } from "./PlaybookStore.ts";

const projectId = ProjectId.make("project:playbook-library");
const otherProjectId = ProjectId.make("project:playbook-library-other");
const missingProjectId = ProjectId.make("project:playbook-library-missing");
const deletedProjectId = ProjectId.make("project:playbook-library-deleted");
const worktreeThread = ThreadId.make("thread:playbook-library-worktree");
const rootThread = ThreadId.make("thread:playbook-library-root");
const missingThread = ThreadId.make("thread:playbook-library-missing");
const deletedThread = ThreadId.make("thread:playbook-library-deleted");
const mismatchedThread = ThreadId.make("thread:playbook-library-other-project");
const unavailableThread = ThreadId.make("thread:playbook-library-read-failed");
const createdAt = "2026-09-21T09:00:00.000Z";
const encodeBody = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const decodeLibrary = Schema.decodeUnknownEffect(PlaybookLibraryResponse);
const decodeAuthError = Schema.decodeUnknownEffect(EnvironmentAuthInvalidError);
const decodeScopeError = Schema.decodeUnknownEffect(EnvironmentScopeRequiredError);
const decodeInternalError = Schema.decodeUnknownEffect(EnvironmentInternalError);
const decodeRequestError = Schema.decodeUnknownEffect(
  Schema.Struct({ error: Schema.String, message: Schema.String }),
);
const TestLayer = Layer.mergeAll(NodeSqliteClient.layerMemory(), NodeServices.layer);

const definition = (title: string) => ({
  title,
  description: `Purpose of ${title}.`,
  steps: [{ id: "first", title: "First step", prompt: "PRIVATE_LIBRARY_PROMPT" }],
});

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "j5-playbook-library-http-" });
  const projectRoot = path.join(directory, "project");
  const worktree = path.join(directory, "worktree");
  const filename = (root: string, name = "demo") =>
    path.join(root, ".j5/playbooks", `${name}.yaml`);
  for (const [root, title] of [
    [projectRoot, "Project library"],
    [worktree, "Worktree library"],
  ] as const) {
    yield* fs.makeDirectory(path.join(root, ".j5/playbooks"), { recursive: true });
    yield* fs.writeFileString(filename(root), stringify(definition(title)));
  }
  yield* runJ5A2AMigrations();
  const store = yield* makePlaybookStore;
  const projectReads: ProjectId[] = [];
  const threadReads: ThreadId[] = [];
  const projects = Layer.mock(ProjectService)({
    getById: (id) => {
      projectReads.push(id);
      return Effect.succeed(
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
              deletedAt: id === deletedProjectId ? createdAt : null,
            }),
      );
    },
  });
  const threads = Layer.mock(ThreadManagementService)({
    getThreadProjection: (threadId) => {
      threadReads.push(threadId);
      if (threadId === missingThread || threadId === unavailableThread) {
        return Effect.fail(
          new OrchestratorProjectionError({
            threadId,
            cause:
              threadId === missingThread
                ? new ProjectionStoreThreadNotFoundError({ threadId })
                : new Error("Projection database unavailable"),
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
            projectId: threadId === mismatchedThread ? otherProjectId : projectId,
            createdBy: "user",
            creationSource: "web",
            title: "Library test",
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
  const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: (request) => {
      const authorization = request.headers.authorization;
      if (authorization !== "Bearer read" && authorization !== "Bearer without-read") {
        return Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}));
      }
      return Effect.succeed({
        sessionId: AuthSessionId.make("session:playbook-library-http"),
        subject: "playbook-library-test",
        method: "bearer-access-token" as const,
        scopes: authorization === "Bearer read" ? [AuthOrchestrationReadScope] : [],
      });
    },
  });
  const routes = playbookLibraryHttpRouteLayer.pipe(
    Layer.provide(Layer.succeed(PlaybookStore, store)),
    Layer.provide(projects),
    Layer.provide(threads),
    Layer.provideMerge(auth),
    Layer.provide(HttpServer.layerServices),
  );
  const { handler } = yield* Effect.acquireRelease(
    Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
    ({ dispose }) => Effect.promise(dispose),
  );
  const post = (body: Schema.Json, authorization: string | null = "Bearer read") =>
    Effect.promise(() =>
      handler(
        new Request(`http://environment.test${PLAYBOOK_LIBRARY_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(authorization === null ? {} : { authorization }),
          },
          body: encodeBody(body),
        }),
      ),
    );
  const read = Effect.fn("test.playbooks.library.read")(function* (threadId?: ThreadId) {
    const response = yield* post({ projectId, ...(threadId === undefined ? {} : { threadId }) });
    assert.equal(response.status, 200);
    return yield* Effect.promise(() => response.json()).pipe(Effect.flatMap(decodeLibrary));
  });
  return {
    fs,
    filename,
    projectRoot,
    worktree,
    store,
    post,
    read,
    handler,
    projectReads,
    threadReads,
  };
});

it.effect("authenticates library reads before resolving any project or thread workspace", () =>
  Effect.gen(function* () {
    const { post, projectReads, threadReads } = yield* fixture;
    const unauthenticated = yield* post({ projectId, threadId: worktreeThread }, null);
    assert.equal(unauthenticated.status, 401);
    const authError = yield* Effect.promise(() => unauthenticated.json()).pipe(
      Effect.flatMap(decodeAuthError),
    );
    assert.equal(authError.code, "auth_invalid");
    const forbidden = yield* post({ projectId, threadId: worktreeThread }, "Bearer without-read");
    assert.equal(forbidden.status, 403);
    const scopeError = yield* Effect.promise(() => forbidden.json()).pipe(
      Effect.flatMap(decodeScopeError),
    );
    assert.equal(scopeError.requiredScope, AuthOrchestrationReadScope);
    assert.deepStrictEqual(projectReads, []);
    assert.deepStrictEqual(threadReads, []);
    assert.equal((yield* post({ projectId, threadId: worktreeThread })).status, 200);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("selects project or thread worktree definitions without creating any run", () =>
  Effect.gen(function* () {
    const { projectRoot, worktree, read } = yield* fixture;
    const project = yield* read();
    assert.equal(project.workspaceRoot, projectRoot);
    assert.equal(project.playbooks[0]?.title, "Project library");
    const thread = yield* read(worktreeThread);
    assert.equal(thread.workspaceRoot, worktree);
    assert.equal(thread.playbooks[0]?.title, "Worktree library");
    const root = yield* read(rootThread);
    assert.equal(root.workspaceRoot, projectRoot);
    assert.equal(root.playbooks[0]?.title, "Project library");
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM j5_playbook_run`;
    assert.equal(rows[0]?.count, 0);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("returns 404 for missing, deleted, or mismatched workspace identities", () =>
  Effect.gen(function* () {
    const { post } = yield* fixture;
    for (const body of [
      { projectId: missingProjectId },
      { projectId: deletedProjectId },
      { projectId, threadId: missingThread },
      { projectId, threadId: deletedThread },
      { projectId, threadId: mismatchedThread },
    ]) {
      const response = yield* post(body);
      assert.equal(response.status, 404, `workspace lookup ${encodeBody(body)}`);
      const error = yield* Effect.promise(() => response.json()).pipe(
        Effect.flatMap(decodeRequestError),
      );
      assert.equal(error.error, "workspace_not_found");
    }
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("keeps unexpected projection failures distinct from missing workspaces", () =>
  Effect.gen(function* () {
    const { post } = yield* fixture;
    const response = yield* post({ projectId, threadId: unavailableThread });
    assert.equal(response.status, 500);
    const error = yield* Effect.promise(() => response.json()).pipe(
      Effect.flatMap(decodeInternalError),
    );
    assert.equal(error.code, "internal_error");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("shows invalid definitions and live edits while returning only library metadata", () =>
  Effect.gen(function* () {
    const { fs, filename, projectRoot, read, post } = yield* fixture;
    yield* fs.writeFileString(filename(projectRoot, "broken"), "title: [broken");
    const initial = yield* read();
    assert.deepStrictEqual(
      initial.playbooks.map(({ name }) => name),
      ["broken", "demo"],
    );
    assert.equal(initial.playbooks[0]?.issue?.code, "invalid_definition");
    assert.isNull(initial.playbooks[1]?.issue);
    const edited = {
      ...definition("Renamed live"),
      description: "Updated purpose.",
      steps: [
        { id: "revised", title: "Revised phase", prompt: "PRIVATE_REVISED_PROMPT" },
        { id: "finish", title: "Finish phase", prompt: "PRIVATE_FINISH_PROMPT" },
      ],
    };
    yield* fs.writeFileString(filename(projectRoot), stringify(edited));
    const refreshed = yield* read();
    const changed = refreshed.playbooks.find(({ name }) => name === "demo")!;
    assert.equal(changed.title, "Renamed live");
    assert.equal(changed.description, "Updated purpose.");
    assert.equal(changed.stepCount, 2);
    assert.deepStrictEqual(changed.steps, [
      { id: "revised", title: "Revised phase" },
      { id: "finish", title: "Finish phase" },
    ]);
    const response = yield* post({ projectId });
    const text = yield* Effect.promise(() => response.text());
    assert.notInclude(text, "PRIVATE_REVISED_PROMPT");
    assert.notInclude(text, "PRIVATE_FINISH_PROMPT");
    assert.notInclude(text, '"prompt"');
    yield* fs.remove(filename(projectRoot, "broken"));
    yield* fs.remove(filename(projectRoot));
    assert.deepStrictEqual((yield* read()).playbooks, []);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("rejects missing project IDs and malformed JSON", () =>
  Effect.gen(function* () {
    const { post, handler } = yield* fixture;
    for (const body of [{}, { projectId: "" }, { projectId: 42 }, { projectId, threadId: null }]) {
      const response = yield* post(body);
      assert.equal(response.status, 400);
      const error = yield* Effect.promise(() => response.json()).pipe(
        Effect.flatMap(decodeRequestError),
      );
      assert.equal(error.error, "invalid_request");
    }
    const malformed = yield* Effect.promise(() =>
      handler(
        new Request(`http://environment.test${PLAYBOOK_LIBRARY_PATH}`, {
          method: "POST",
          headers: { authorization: "Bearer read", "content-type": "application/json" },
          body: "{broken",
        }),
      ),
    );
    assert.equal(malformed.status, 400);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);
