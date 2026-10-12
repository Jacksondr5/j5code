import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  RpcScopeAuthorization,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as RpcAuthorization from "../../auth/RpcAuthorization.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { runJ5A2AMigrations } from "../a2a/Migrations.ts";
import * as GuestGate from "./GuestGate.ts";
import * as PersonAccess from "./PersonAccess.ts";

const AT = "2026-10-11T00:00:00.000Z";
const PROJECT = ProjectId.make("project:billing-migration");
const GUEST_SCOPES = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope];

const session = (id: string, subject: string): EnvironmentAuth.AuthenticatedSession => ({
  sessionId: AuthSessionId.make(id),
  subject,
  method: "browser-session-cookie",
  scopes: GUEST_SCOPES,
});
const MEMBER = session("session:member", "one-time-token");
const GUEST = session("session:guest", PersonAccess.GUEST_SESSION_SUBJECT);

/**
 * Upstream's auth, reduced to the two calls every route signs in through. Which session a request
 * carries is read from a header, the way a credential would be.
 */
const sessionsByName: Record<string, EnvironmentAuth.AuthenticatedSession> = {
  member: MEMBER,
  guest: GUEST,
};
const upstreamAuth = Layer.succeed(
  EnvironmentAuth.EnvironmentAuth,
  // The gate decorates these two methods and passes the rest through untouched.
  {
    authenticateHttpRequest: (request: HttpServerRequest.HttpServerRequest) =>
      Effect.succeed(sessionsByName[request.headers["x-test-session"] ?? ""]!),
    authenticateWebSocketUpgrade: (request: HttpServerRequest.HttpServerRequest) =>
      Effect.succeed(sessionsByName[request.headers["x-test-session"] ?? ""]!),
  } as unknown as EnvironmentAuth.EnvironmentAuth["Service"],
);

const database = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* runMigrations();
    yield* runJ5A2AMigrations();
  }),
).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })));

const testLayer = GuestGate.gateEnvironmentAuth(upstreamAuth.pipe(Layer.provideMerge(database)));

const request = (who: "member" | "guest", method: string, url: string) =>
  ({
    method,
    url,
    headers: { "x-test-session": who },
  }) as unknown as HttpServerRequest.HttpServerRequest;

const thread = Effect.fn("test.thread")(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode,
      interaction_mode, active_provider_thread_id, created_at, updated_at,
      archived_at, deleted_at, payload_json
    ) VALUES (
      ${id}, ${PROJECT}, ${id}, 'codex', 'full-access', 'default', NULL, ${AT}, ${AT},
      NULL, NULL, '{}'
    )
  `;
  return ThreadId.make(id);
});

/** The guest of these tests, with a grant on one thread at the level asked for. */
const grantGuest = Effect.fn("test.grantGuest")(function* (
  threadId: ThreadId,
  level: PersonAccess.GrantLevel,
) {
  const access = yield* PersonAccess.PersonAccess;
  const sql = yield* SqlClient.SqlClient;
  const existing = yield* sql<{ readonly person_id: string }>`
    SELECT person_id FROM j5_a2a_person_session WHERE session_id = ${GUEST.sessionId}
  `;
  const personId =
    existing[0] === undefined
      ? (yield* access.createGuest({ displayName: "Contractor" })).personId
      : (existing[0].person_id as PersonAccess.Person["personId"]);
  if (existing[0] === undefined) {
    yield* access.bindSession({ sessionId: GUEST.sessionId, personId });
  }
  yield* access.putGrant({ personId, target: { kind: "thread", threadId }, level });
});

const scopesFor = Effect.fn("test.scopesFor")(function* (
  who: "member" | "guest",
  method: string,
  url: string,
) {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const http = yield* auth.authenticateHttpRequest(request(who, method, url));
  const upgrade = yield* auth.authenticateWebSocketUpgrade(request(who, method, url));
  // Both entrances are gated alike: a route may sign in through either.
  assert.deepStrictEqual(http.scopes, upgrade.scopes);
  return http.scopes;
});

it("names the few routes a guest keeps permissions on", () => {
  const thread = (id: string): GuestGate.GuestHttpRule => ({
    kind: "thread",
    threadId: ThreadId.make(id),
  });
  assert.deepStrictEqual(GuestGate.guestHttpRule("GET", "/ws"), { kind: "open" });
  assert.deepStrictEqual(GuestGate.guestHttpRule("GET", "/api/orchestration/shell"), {
    kind: "open",
  });
  assert.deepStrictEqual(
    GuestGate.guestHttpRule("GET", "/api/orchestration/threads/t1"),
    thread("t1"),
  );
  assert.deepStrictEqual(
    GuestGate.guestHttpRule("GET", "/api/orchestration/threads/t1/bounded"),
    thread("t1"),
  );
  assert.deepStrictEqual(
    GuestGate.guestHttpRule("GET", "/api/orchestration/threads/t1/history"),
    thread("t1"),
  );
  assert.deepStrictEqual(
    GuestGate.guestHttpRule("GET", "/api/orchestration/threads/thread%3Aone"),
    thread("thread:one"),
  );
  for (const [method, path] of [
    ["GET", "/api/orchestration/shell/archived"],
    ["GET", "/api/orchestration/shell/"],
    ["POST", "/api/orchestration/shell"],
    ["GET", "/api/projects"],
    ["GET", "/api/auth/pairing-links"],
    ["GET", "/api/preview-stream/ws"],
    ["GET", "/api/assets"],
    ["GET", "/api/orchestration/threads/t1/anything-else"],
    ["GET", "/api/orchestration/threads/t1/bounded/extra"],
    ["GET", "/api/orchestration/threads/"],
    ["GET", "/api/orchestration/threads/%E0%A4%A"],
    ["POST", "/api/orchestration/threads/t1"],
    ["POST", "/ws"],
  ] as const) {
    assert.deepStrictEqual(GuestGate.guestHttpRule(method, path), { kind: "refuse" }, path);
  }
});

it.layer(testLayer)("guest gate", (it) => {
  it.effect("leaves a member's session alone on every route", () =>
    Effect.gen(function* () {
      for (const url of ["/ws", "/api/projects", "/api/orchestration/threads/thread:any"]) {
        assert.deepStrictEqual(yield* scopesFor("member", "GET", url), GUEST_SCOPES);
      }
    }),
  );

  it.effect("gives a guest their permissions on a granted thread's loads and the socket only", () =>
    Effect.gen(function* () {
      const granted = yield* thread("thread:http-granted");
      yield* thread("thread:http-other");
      yield* grantGuest(granted, "view");
      for (const url of [
        "/ws",
        "/api/orchestration/shell",
        "/api/orchestration/threads/thread%3Ahttp-granted",
        "/api/orchestration/threads/thread%3Ahttp-granted/bounded?compactTurnItems=1",
        "/api/orchestration/threads/thread%3Ahttp-granted/history?cursor=abc",
      ]) {
        assert.deepStrictEqual(yield* scopesFor("guest", "GET", url), GUEST_SCOPES, url);
      }
      for (const url of [
        "/api/orchestration/threads/thread%3Ahttp-other",
        "/api/orchestration/threads/thread%3Ahttp-other/bounded",
        "/api/orchestration/threads/thread%3Adoes-not-exist",
        "/api/projects",
        "/api/auth/clients",
        "/api/preview-stream/ws?threadId=thread%3Ahttp-granted&tabId=1",
        "/api/assets?token=abc",
        "/api/j5/inbox",
      ]) {
        assert.deepStrictEqual(yield* scopesFor("guest", "GET", url), [], url);
      }
      assert.deepStrictEqual(
        yield* scopesFor("guest", "POST", "/api/orchestration/threads/thread%3Ahttp-granted"),
        [],
      );
    }),
  );

  it.effect("stops giving a guest a thread when the grant is removed", () =>
    Effect.gen(function* () {
      const access = yield* PersonAccess.PersonAccess;
      const threadId = yield* thread("thread:http-removed");
      yield* grantGuest(threadId, "view");
      const url = "/api/orchestration/threads/thread%3Ahttp-removed";
      assert.deepStrictEqual(yield* scopesFor("guest", "GET", url), GUEST_SCOPES);
      const person = yield* access.sessionPerson(GUEST);
      yield* access.removeGrant({
        personId: person!.personId!,
        target: { kind: "thread", threadId },
      });
      assert.deepStrictEqual(yield* scopesFor("guest", "GET", url), []);
    }),
  );
});

/** Runs one request through a connection's authorization and reports whether its handler ran. */
const call = Effect.fn("test.call")(function* (
  who: EnvironmentAuth.AuthenticatedSession,
  method: string,
  payload: unknown,
) {
  const authorize = yield* RpcScopeAuthorization.pipe(
    Effect.provide(GuestGate.layerRpcAuthorization(who, RpcAuthorization.layer(who.scopes))),
  );
  type Handler = Parameters<typeof authorize>[0];
  const outcome = yield* authorize(
    Effect.succeed("ran") as unknown as Handler,
    {
      rpc: { _tag: method },
      payload,
    } as unknown as Parameters<typeof authorize>[1],
  ).pipe(
    Effect.catchTags({
      EnvironmentAuthorizationError: (error) => Effect.succeed(`refused: ${error.message}`),
    }),
  );
  return String(outcome);
});

it.layer(testLayer)("guest RPC authorization", (it) => {
  it.effect("a member's connection is upstream's check and nothing more", () =>
    Effect.gen(function* () {
      const threadId = yield* thread("thread:rpc-member");
      assert.strictEqual(
        yield* call(MEMBER, ORCHESTRATION_V2_WS_METHODS.subscribeThread, { threadId }),
        "ran",
      );
      assert.strictEqual(
        yield* call(MEMBER, ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {}),
        "ran",
      );
      assert.strictEqual(
        yield* call(MEMBER, ORCHESTRATION_V2_WS_METHODS.subscribeShell, {}),
        "ran",
      );
    }),
  );

  it.effect("a guest reads a granted thread and nothing else", () =>
    Effect.gen(function* () {
      const granted = yield* thread("thread:rpc-granted");
      const other = yield* thread("thread:rpc-other");
      yield* grantGuest(granted, "view");
      for (const method of [
        ORCHESTRATION_V2_WS_METHODS.subscribeThread,
        ORCHESTRATION_V2_WS_METHODS.getTurnDiff,
        ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff,
        ORCHESTRATION_V2_WS_METHODS.getTurnItem,
        ORCHESTRATION_V2_WS_METHODS.searchThread,
        ORCHESTRATION_V2_WS_METHODS.searchThreadStream,
      ]) {
        assert.strictEqual(yield* call(GUEST, method, { threadId: granted }), "ran", method);
        assert.match(yield* call(GUEST, method, { threadId: other }), /^refused: /, method);
        assert.match(yield* call(GUEST, method, {}), /^refused: /, method);
      }
    }),
  );

  it.effect("a guest may ask for the feeds its client cannot connect without", () =>
    Effect.gen(function* () {
      // `GuestView` narrows what each of these answers; a guest with no grants may ask too.
      const stray = session("session:stray", PersonAccess.GUEST_SESSION_SUBJECT);
      for (const method of [
        WS_METHODS.serverGetConfig,
        WS_METHODS.subscribeServerConfig,
        WS_METHODS.subscribeServerLifecycle,
        ORCHESTRATION_V2_WS_METHODS.subscribeShell,
      ]) {
        assert.strictEqual(yield* call(GUEST, method, {}), "ran", method);
        assert.strictEqual(yield* call(stray, method, {}), "ran", method);
        // Upstream's own permission check still runs after the guest's.
        assert.match(yield* call({ ...GUEST, scopes: [] }, method, {}), /^refused: /, method);
      }
      assert.deepStrictEqual(
        Object.entries(GuestGate.GUEST_RPC_RULES)
          .flatMap(([method, rule]) => (rule.kind === "narrowed" ? [method] : []))
          .toSorted(),
        [
          ORCHESTRATION_V2_WS_METHODS.subscribeShell,
          WS_METHODS.serverGetConfig,
          WS_METHODS.subscribeServerConfig,
          WS_METHODS.subscribeServerLifecycle,
        ].toSorted(),
      );
    }),
  );

  it.effect("a guest is refused every request that is not listed, whatever it names", () =>
    Effect.gen(function* () {
      const granted = yield* thread("thread:rpc-unlisted");
      yield* grantGuest(granted, "collaborate");
      for (const method of [
        // Holds the permission upstream asks for, and names the granted thread.
        ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
        ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
        ORCHESTRATION_V2_WS_METHODS.launchThread,
        // Feeds and reads that carry every thread, the host's settings or the host's files.
        ORCHESTRATION_V2_WS_METHODS.searchThreads,
        ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot,
        ORCHESTRATION_V2_WS_METHODS.subscribeArchivedShell,
        WS_METHODS.serverGetSettings,
        WS_METHODS.serverProbe,
        WS_METHODS.serverRefreshProviders,
        WS_METHODS.subscribeAuthAccess,
        WS_METHODS.projectsReadFile,
        WS_METHODS.terminalOpen,
        "a.method.upstream.adds.later",
      ]) {
        assert.match(yield* call(GUEST, method, { threadId: granted }), /^refused: /, method);
      }
    }),
  );
});
