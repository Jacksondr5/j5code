import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentAuthInvalidError,
  EnvironmentScopeRequiredError,
  ThreadId,
} from "@t3tools/contracts";
import {
  PLAYBOOK_PROGRESS_PATH,
  PLAYBOOK_RUNS_PATH,
  PlaybookRunsResponse,
  ThreadPlaybooksResponse,
} from "@t3tools/contracts/j5";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { stringify } from "yaml";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { runJ5A2AMigrations } from "../a2a/Migrations.ts";
import { playbookHttpRouteLayer } from "./PlaybookHttp.ts";
import { makePlaybookStore, PlaybookStore } from "./PlaybookStore.ts";

const owner = ThreadId.make("thread:playbook-http:owner");
const otherOwner = ThreadId.make("thread:playbook-http:other");
const decodeProgress = Schema.decodeUnknownEffect(ThreadPlaybooksResponse);
const decodeRuns = Schema.decodeUnknownEffect(PlaybookRunsResponse);
const decodeRunsJson = Schema.decodeUnknownEffect(Schema.fromJsonString(PlaybookRunsResponse));
const encodeBody = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const decodeAuthError = Schema.decodeUnknownEffect(EnvironmentAuthInvalidError);
const decodeScopeError = Schema.decodeUnknownEffect(EnvironmentScopeRequiredError);
const decodeRequestError = Schema.decodeUnknownEffect(
  Schema.Struct({ error: Schema.String, message: Schema.String }),
);
const TestLayer = Layer.mergeAll(NodeSqliteClient.layerMemory(), NodeServices.layer);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "j5-playbook-http-" });
  yield* fs.makeDirectory(path.join(workspaceRoot, ".j5/playbooks"), { recursive: true });
  const filename = path.join(workspaceRoot, ".j5/playbooks/demo.yaml");
  yield* fs.writeFileString(
    filename,
    stringify({
      title: "HTTP sample",
      description: "Inspect progress from a connected client.",
      steps: [
        { id: "one", title: "First phase", prompt: "PRIVATE_FIRST_PROMPT" },
        { id: "two", title: "Second phase", prompt: "PRIVATE_SECOND_PROMPT" },
      ],
    }),
  );
  yield* runJ5A2AMigrations();
  const store = yield* makePlaybookStore;
  const run = yield* store.start(owner, workspaceRoot, "demo", "start-owner");
  const other = yield* store.start(otherOwner, workspaceRoot, "demo", "start-other");
  const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: (request) => {
      const authorization = request.headers.authorization;
      if (authorization !== "Bearer read" && authorization !== "Bearer without-read") {
        return Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}));
      }
      return Effect.succeed({
        sessionId: AuthSessionId.make("session:playbook-http"),
        subject: "playbook-http-test",
        method: "bearer-access-token" as const,
        scopes: authorization === "Bearer read" ? [AuthOrchestrationReadScope] : [],
      });
    },
  });
  const routes = playbookHttpRouteLayer.pipe(
    Layer.provide(Layer.succeed(PlaybookStore, store)),
    Layer.provideMerge(auth),
    Layer.provide(HttpServer.layerServices),
  );
  const { handler } = yield* Effect.acquireRelease(
    Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
    ({ dispose }) => Effect.promise(dispose),
  );
  const post = (
    body: Schema.Json,
    authorization: string | null = "Bearer read",
    route: string = PLAYBOOK_PROGRESS_PATH,
  ) =>
    Effect.promise(() =>
      handler(
        new Request(`http://environment.test${route}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(authorization === null ? {} : { authorization }),
          },
          body: encodeBody(body),
        }),
      ),
    );
  const read = Effect.fn("test.playbooks.http.read")(function* (threadId: ThreadId) {
    const response = yield* post({ threadId });
    assert.equal(response.status, 200);
    return yield* Effect.promise(() => response.json()).pipe(Effect.flatMap(decodeProgress));
  });
  return { fs, filename, store, run, other, post, read, handler };
});

it.effect(
  "serves the overview with read scope, validated paging, and prompt-free progress for every owner",
  () =>
    Effect.gen(function* () {
      const { post, store, run, other } = yield* fixture;
      assert.equal((yield* post({}, null, PLAYBOOK_RUNS_PATH)).status, 401);
      assert.equal((yield* post({}, "Bearer without-read", PLAYBOOK_RUNS_PATH)).status, 403);
      for (const body of [{ offset: -1 }, { offset: 1.5 }, { status: "finished" }]) {
        assert.equal((yield* post(body, "Bearer read", PLAYBOOK_RUNS_PATH)).status, 400);
      }
      const response = yield* post({}, "Bearer read", PLAYBOOK_RUNS_PATH);
      assert.equal(response.status, 200);
      const text = yield* Effect.promise(() => response.text());
      const data = yield* decodeRunsJson(text);
      assert.equal(data.total, 2);
      assert.deepStrictEqual(
        new Set(data.runs.map((entry) => entry.runId)),
        new Set([run.runId, other.runId]),
      );
      assert.deepStrictEqual(
        new Set(data.runs.map((entry) => entry.ownerThreadId)),
        new Set([owner, otherOwner]),
      );
      assert.notInclude(text, "PRIVATE_FIRST_PROMPT");
      assert.notInclude(text, "PRIVATE_SECOND_PROMPT");
      assert.notInclude(text, '"prompt"');
      assert.notInclude(text, '"currentStep"');
      yield* store.mutate(owner, {
        operation: "complete",
        runId: run.runId,
        expectedStepId: "one",
        client_request_id: "finish",
      });
      const activeResponse = yield* post(
        { status: "active", offset: 0 },
        "Bearer read",
        PLAYBOOK_RUNS_PATH,
      );
      const active = yield* Effect.promise(() => activeResponse.json()).pipe(
        Effect.flatMap(decodeRuns),
      );
      assert.equal(active.total, 1);
      assert.equal(active.runs[0]?.runId, other.runId);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect(
  "requires credentials and orchestration read scope before returning thread progress",
  () =>
    Effect.gen(function* () {
      const { post } = yield* fixture;
      const unauthenticated = yield* post({ threadId: owner }, null);
      assert.equal(unauthenticated.status, 401);
      const authError = yield* Effect.promise(() => unauthenticated.json()).pipe(
        Effect.flatMap(decodeAuthError),
      );
      assert.equal(authError.code, "auth_invalid");
      const forbidden = yield* post({ threadId: owner }, "Bearer without-read");
      assert.equal(forbidden.status, 403);
      const scopeError = yield* Effect.promise(() => forbidden.json()).pipe(
        Effect.flatMap(decodeScopeError),
      );
      assert.equal(scopeError.requiredScope, AuthOrchestrationReadScope);
      const allowed = yield* post({ threadId: owner });
      assert.equal(allowed.status, 200);
      const progress = yield* Effect.promise(() => allowed.json()).pipe(
        Effect.flatMap(decodeProgress),
      );
      assert.equal(progress.runs[0]?.ownerThreadId, owner);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("returns each thread's live phase progress without any prompt bodies", () =>
  Effect.gen(function* () {
    const { store, run, other, read, post } = yield* fixture;
    yield* store.mutate(owner, {
      operation: "next",
      runId: run.runId,
      expectedStepId: "one",
      client_request_id: "next",
    });
    const first = yield* read(owner);
    const second = yield* read(otherOwner);
    assert.equal(first.runs.length, 1);
    assert.equal(first.runs[0]?.runId, run.runId);
    assert.equal(first.runs[0]?.currentStepId, "two");
    assert.equal(first.runs[0]?.position, 2);
    assert.deepStrictEqual(first.runs[0]?.steps, [
      { id: "one", title: "First phase" },
      { id: "two", title: "Second phase" },
    ]);
    assert.equal(second.runs.length, 1);
    assert.equal(second.runs[0]?.runId, other.runId);
    assert.equal(second.runs[0]?.currentStepId, "one");
    assert.deepStrictEqual((yield* read(ThreadId.make("thread:unknown"))).runs, []);
    const raw = yield* post({ threadId: owner });
    const text = yield* Effect.promise(() => raw.text());
    assert.notInclude(text, "PRIVATE_FIRST_PROMPT");
    assert.notInclude(text, "PRIVATE_SECOND_PROMPT");
    assert.notInclude(text, '"prompt"');
    assert.notInclude(text, '"currentStep"');

    yield* store.mutate(owner, {
      operation: "complete",
      runId: run.runId,
      expectedStepId: "two",
      client_request_id: "complete",
    });
    assert.equal((yield* read(owner)).runs[0]?.status, "completed");
    assert.equal((yield* read(otherOwner)).runs[0]?.status, "active");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("keeps broken definitions visible and reflects cancellation in HTTP progress", () =>
  Effect.gen(function* () {
    const { fs, filename, store, run, read } = yield* fixture;
    yield* fs.writeFileString(filename, "title: [invalid");
    const broken = (yield* read(owner)).runs[0]!;
    assert.equal(broken.status, "active");
    assert.equal(broken.currentStepId, "one");
    assert.equal(broken.issue?.code, "invalid_definition");
    assert.deepStrictEqual(broken.steps, []);
    yield* store.mutate(owner, {
      operation: "cancel",
      runId: run.runId,
      client_request_id: "cancel",
    });
    const cancelled = (yield* read(owner)).runs[0]!;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.issue?.code, "invalid_definition");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("rejects missing thread IDs and malformed JSON", () =>
  Effect.gen(function* () {
    const { post, handler } = yield* fixture;
    for (const body of [{}, { threadId: 42 }, { threadId: "" }]) {
      const response = yield* post(body);
      assert.equal(response.status, 400);
      const error = yield* Effect.promise(() => response.json()).pipe(
        Effect.flatMap(decodeRequestError),
      );
      assert.equal(error.error, "invalid_request");
    }
    const malformed = yield* Effect.promise(() =>
      handler(
        new Request(`http://environment.test${PLAYBOOK_PROGRESS_PATH}`, {
          method: "POST",
          headers: { authorization: "Bearer read", "content-type": "application/json" },
          body: "{broken",
        }),
      ),
    );
    assert.equal(malformed.status, 400);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);
