import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { AuthSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { makeDpopKey } from "../../auth/dpop.testkit.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import * as AccessGate from "../sharing/AccessGate.ts";
import * as PersonAccess from "../sharing/PersonAccess.ts";
import { peopleLayer, person } from "../sharing/test-support/accessHarness.ts";
import * as Identity from "./Identity.ts";
import * as FakeConnect from "./test-support/fakeConnect.ts";

// Sign-in as the server composes it, over upstream's real auth and a J5 Connect in-process. The
// hourly loop is left out, so each test runs `confirmAll` itself at the hour it means.
const makeLayer = () =>
  Identity.layer.pipe(
    Layer.provideMerge(AccessGate.layerGatedEnvironmentAuth),
    Layer.provideMerge(
      EnvironmentAuth.layer.pipe(
        Layer.provideMerge(peopleLayer),
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provide(ServerEnvironment.layerIdentity),
        Layer.provide(ManagedPolicy.layerTest()),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "j5-identity-" })),
      ),
    ),
    Layer.provideMerge(FakeConnect.layer),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const requestMetadata = { deviceType: "desktop" as const, os: "Linux", browser: "Firefox" };

/** Joins the fake J5 Connect, registering whatever return addresses the first try asks for. */
const joined = Effect.gen(function* () {
  const identity = yield* Identity.Identity;
  const connect = yield* FakeConnect.FakeConnect;
  const join = identity.join({
    issuer: FakeConnect.ISSUER,
    clientId: FakeConnect.CLIENT_ID,
    clientSecret: FakeConnect.CLIENT_SECRET,
    addresses: [],
  });
  const first = yield* Effect.flip(join);
  if (first._tag !== "ReturnUrlsNotRegisteredError") return yield* Effect.die(first);
  for (const url of first.toRegister) connect.returnUrls.add(url);
  return yield* join;
});

/** One full sign-in by `subject` at the server's first address, as a browser would. */
const signIn = Effect.fn("test.signIn")(function* (subject: string) {
  const identity = yield* Identity.Identity;
  const connect = yield* FakeConnect.FakeConnect;
  const state = yield* identity.state;
  const origin = new URL(state.connect!.returnUrls[0]!).origin;
  const authorizationUrl = yield* identity.startSignIn(origin);
  const code = connect.signIn(authorizationUrl, subject);
  return yield* identity.completeSignIn({
    state: new URL(authorizationUrl).searchParams.get("state")!,
    code,
  });
});

const addUser = Effect.fn("test.addUser")(function* (subject: string, name: string) {
  const connect = yield* FakeConnect.FakeConnect;
  connect.users.set(subject, { email: `${subject}@example.test`, name, active: true });
});

/** A bound account's browser, signed in and paired from the credential its sign-in gave. */
const pairedBrowser = Effect.fn("test.pairedBrowser")(function* (subject: string) {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const sessions = yield* SessionStore.SessionStore;
  const outcome = yield* signIn(subject);
  if (outcome.kind !== "pair") return yield* Effect.die(outcome.kind);
  const paired = yield* auth.createBrowserSession(outcome.credential, requestMetadata);
  return (yield* sessions.verify(paired.sessionToken)).sessionId;
});

const isLive = Effect.fn("test.isLive")(function* (sessionId: AuthSessionId) {
  const sessions = yield* SessionStore.SessionStore;
  return (yield* sessions.listActive()).some((session) => session.sessionId === sessionId);
});

const countPeople = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly n: number }>`
    SELECT COUNT(*) AS n FROM j5_a2a_human_person WHERE removed_at IS NULL
  `;
  return rows[0]!.n;
});

const grantAda = Effect.gen(function* () {
  const identity = yield* Identity.Identity;
  yield* addUser("ada", "Ada");
  assert.deepStrictEqual(yield* signIn("ada"), { kind: "waiting" });
  const [request] = (yield* identity.state).requests;
  return yield* identity.grant({
    accountId: request!.accountId,
    name: "Ada",
    scope: { kind: "server" },
    level: "collaborator",
  });
});

it.effect("joining checks the client's secret and every return address before it trusts", () =>
  Effect.gen(function* () {
    const identity = yield* Identity.Identity;
    const connect = yield* FakeConnect.FakeConnect;
    const wrongSecret = yield* Effect.flip(
      identity.join({
        issuer: FakeConnect.ISSUER,
        clientId: FakeConnect.CLIENT_ID,
        clientSecret: "not-the-secret",
        addresses: [],
      }),
    );
    assert.strictEqual(wrongSecret._tag, "ClientSecretRefusedError");

    const missing = yield* Effect.flip(
      identity.join({
        issuer: FakeConnect.ISSUER,
        clientId: FakeConnect.CLIENT_ID,
        clientSecret: FakeConnect.CLIENT_SECRET,
        addresses: ["https://j5.example.test"],
      }),
    );
    if (missing._tag !== "ReturnUrlsNotRegisteredError") return assert.fail(missing._tag);
    assert.include(missing.toRegister, "https://j5.example.test/api/j5/identity/callback");
    assert.isTrue(missing.toRegister.every((url) => url.endsWith("/api/j5/identity/callback")));
    assert.isNull((yield* identity.describe).signIn);

    for (const url of missing.toRegister.slice(1)) connect.returnUrls.add(url);
    const stillMissing = yield* Effect.flip(
      identity.join({
        issuer: FakeConnect.ISSUER,
        clientId: FakeConnect.CLIENT_ID,
        clientSecret: FakeConnect.CLIENT_SECRET,
        addresses: ["https://j5.example.test"],
      }),
    );
    if (stillMissing._tag !== "ReturnUrlsNotRegisteredError") return assert.fail(stillMissing._tag);
    assert.deepStrictEqual(stillMissing.missing, missing.toRegister.slice(0, 1));

    connect.returnUrls.add(missing.toRegister[0]!);
    const done = yield* identity.join({
      issuer: FakeConnect.ISSUER,
      clientId: FakeConnect.CLIENT_ID,
      clientSecret: FakeConnect.CLIENT_SECRET,
      addresses: ["https://j5.example.test"],
    });
    assert.deepStrictEqual(done.returnUrls, missing.toRegister);
    assert.deepStrictEqual(yield* identity.describe, {
      signIn: { host: "connect.example.test" },
    });
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("an account that is no one yet waits for an Owner, and sign-in makes no person", () =>
  Effect.gen(function* () {
    const identity = yield* Identity.Identity;
    yield* joined;
    yield* addUser("grace", "Grace");
    const before = yield* countPeople;

    assert.deepStrictEqual(yield* signIn("grace"), { kind: "waiting" });
    assert.deepStrictEqual(yield* signIn("grace"), { kind: "waiting" });
    const state = yield* identity.state;
    assert.strictEqual(state.requests.length, 1);
    assert.strictEqual(state.requests[0]!.email, "grace@example.test");
    assert.strictEqual(yield* countPeople, before);

    yield* identity.decline(state.requests[0]!.accountId);
    assert.deepStrictEqual(yield* signIn("grace"), { kind: "not-let-in" });
    assert.strictEqual((yield* identity.state).requests.length, 0);

    // Declined or expired is said alike; once the request is past its week, one sign-in asks again.
    yield* TestClock.adjust("8 days");
    assert.deepStrictEqual(yield* signIn("grace"), { kind: "waiting" });
    assert.strictEqual(yield* countPeople, before);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("a granted account pairs its browser as its new person, as a link would", () =>
  Effect.gen(function* () {
    const people = yield* PersonAccess.PersonAccess;
    const sql = yield* SqlClient.SqlClient;
    yield* joined;
    const adaId = yield* grantAda;
    assert.deepStrictEqual(
      (yield* people.listLevels(adaId)).map((held) => held.level),
      ["collaborator"],
    );

    const sessionId = yield* pairedBrowser("ada");
    const reach = yield* people.sessionReach({ sessionId, subject: "j5:link" });
    assert.strictEqual(reach.kind === "person" ? reach.person.personId : null, adaId);
    const bound = yield* sql<{ readonly sign_in_account_id: string | null }>`
      SELECT sign_in_account_id FROM j5_a2a_person_session WHERE session_id = ${sessionId}
    `;
    assert.isNotNull(bound[0]?.sign_in_account_id);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("an Owner binds an existing person, once each way, and unbinding ends sign-in", () =>
  Effect.gen(function* () {
    const identity = yield* Identity.Identity;
    yield* joined;
    const lin = yield* person("Lin", [{ scope: { kind: "server" }, level: "viewer" }]);
    const other = yield* person("Other", [{ scope: { kind: "server" }, level: "viewer" }]);
    yield* addUser("lin", "Lin");
    yield* addUser("lin-second", "Lin");
    assert.deepStrictEqual(yield* signIn("lin"), { kind: "waiting" });
    assert.deepStrictEqual(yield* signIn("lin-second"), { kind: "waiting" });

    const requests = (yield* identity.state).requests;
    const first = requests.find((request) => request.email === "lin@example.test")!;
    const second = requests.find((request) => request.email === "lin-second@example.test")!;
    // Offered by name, and bound only when the Owner says so.
    assert.deepStrictEqual(first.suggested, { personId: lin.personId, name: "Lin" });
    yield* identity.bind({ accountId: first.accountId, personId: lin.personId });

    const personTaken = yield* Effect.flip(
      identity.bind({ accountId: second.accountId, personId: lin.personId }),
    );
    assert.strictEqual(personTaken._tag, "PersonAlreadyBoundError");
    const accountTaken = yield* Effect.flip(
      identity.bind({ accountId: first.accountId, personId: other.personId }),
    );
    assert.strictEqual(accountTaken._tag, "AccountAlreadyBoundError");

    const sessionId = yield* pairedBrowser("lin");
    assert.isTrue(yield* isLive(sessionId));
    yield* identity.unbind(lin.personId);
    assert.isFalse(yield* isLive(sessionId));
    assert.strictEqual(
      (yield* Effect.flip(identity.unbind(lin.personId)))._tag,
      "PersonNotBoundError",
    );
    // The account is no one's again, and asks afresh.
    assert.deepStrictEqual(yield* signIn("lin"), { kind: "waiting" });
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("a sign-in's state is used once, and a token that does not check out is refused", () =>
  Effect.gen(function* () {
    const identity = yield* Identity.Identity;
    const connect = yield* FakeConnect.FakeConnect;
    yield* joined;
    yield* grantAda;
    const origin = new URL((yield* identity.state).connect!.returnUrls[0]!).origin;

    const url = yield* identity.startSignIn(origin);
    const state = new URL(url).searchParams.get("state")!;
    yield* identity.completeSignIn({ state, code: connect.signIn(url, "ada") });
    const replay = yield* Effect.flip(
      identity.completeSignIn({ state, code: connect.signIn(url, "ada") }),
    );
    assert.strictEqual(replay._tag, "SignInExpiredError");

    for (const claims of [
      { iss: "https://elsewhere.example.test" },
      { aud: "another-client" },
      { nonce: "not-the-nonce" },
    ]) {
      const next = yield* identity.startSignIn(origin);
      connect.nextClaims = claims;
      const refused = yield* Effect.flip(
        identity.completeSignIn({
          state: new URL(next).searchParams.get("state")!,
          code: connect.signIn(next, "ada"),
        }),
      );
      assert.strictEqual(refused._tag, "OidcError");
    }

    const unregistered = yield* Effect.flip(identity.startSignIn("http://198.51.100.7:3773"));
    assert.strictEqual(unregistered._tag, "AddressNotRegisteredError");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("an account J5 Connect keeps confirming keeps its sign-in past a day", () =>
  Effect.gen(function* () {
    const identity = yield* Identity.Identity;
    yield* joined;
    yield* grantAda;
    const sessionId = yield* pairedBrowser("ada");
    for (let hour = 0; hour < 30; hour += 1) {
      yield* TestClock.adjust("1 hour");
      yield* identity.confirmAll;
    }
    assert.isTrue(yield* isLive(sessionId));
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("an outage shorter than a day changes nothing", () =>
  Effect.gen(function* () {
    const identity = yield* Identity.Identity;
    const connect = yield* FakeConnect.FakeConnect;
    yield* joined;
    yield* grantAda;
    const sessionId = yield* pairedBrowser("ada");
    connect.outage = true;
    for (let hour = 0; hour < 23; hour += 1) {
      yield* TestClock.adjust("1 hour");
      yield* identity.confirmAll;
    }
    assert.isTrue(yield* isLive(sessionId));
    connect.outage = false;
    yield* TestClock.adjust("1 hour");
    yield* identity.confirmAll;
    yield* TestClock.adjust("23 hours");
    yield* identity.confirmAll;
    assert.isTrue(yield* isLive(sessionId));
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("a disabled account's sign-in lapses after a day, closing its open socket", () =>
  Effect.gen(function* () {
    const identity = yield* Identity.Identity;
    const connect = yield* FakeConnect.FakeConnect;
    const sessions = yield* SessionStore.SessionStore;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    yield* joined;
    yield* grantAda;
    const browser = yield* pairedBrowser("ada");
    // A phone too, whose session is bound to a key it holds.
    const outcome = yield* signIn("ada");
    if (outcome.kind !== "pair") return assert.fail(outcome.kind);
    const key = makeDpopKey();
    const phone = yield* auth.exchangeBootstrapCredentialForAccessToken(
      outcome.credential,
      undefined,
      { deviceType: "mobile", os: "iOS", browser: "Safari" },
      { proofKeyThumbprint: key.thumbprint },
    );
    const phoneSession = (yield* sessions.verify(phone.access_token)).sessionId;
    const socket = yield* Effect.forkChild(sessions.awaitInvalidation(browser));

    connect.users.get("ada")!.active = false;
    yield* TestClock.adjust("23 hours");
    yield* identity.confirmAll;
    assert.isTrue(yield* isLive(browser));

    yield* TestClock.adjust("1 hour");
    yield* identity.confirmAll;
    assert.isFalse(yield* isLive(browser));
    assert.isFalse(yield* isLive(phoneSession));
    assert.isTrue(Exit.isSuccess(yield* Fiber.await(socket)));

    // Signing in again works only once the company account is active again.
    connect.users.get("ada")!.active = true;
    assert.strictEqual((yield* signIn("ada")).kind, "pair");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("a lapsed Owner's MCP clients end as a removed Owner's do", () =>
  Effect.gen(function* () {
    const identity = yield* Identity.Identity;
    const connect = yield* FakeConnect.FakeConnect;
    const sessions = yield* SessionStore.SessionStore;
    const sql = yield* SqlClient.SqlClient;
    yield* joined;
    const owner = yield* person("Bea", [{ scope: { kind: "server" }, level: "owner" }]);
    yield* addUser("bea", "Bea");
    yield* signIn("bea");
    const [request] = (yield* identity.state).requests;
    yield* identity.bind({ accountId: request!.accountId, personId: owner.personId });
    yield* pairedBrowser("bea");
    const mcp = yield* sessions.issue({
      method: "bearer-access-token",
      subject: "mcp-client",
      scopes: [],
    });
    yield* sql`
      INSERT INTO j5_a2a_mcp_client_approver (session_id, person_id, expires_at)
      VALUES (${mcp.sessionId}, ${owner.personId}, '2999-01-01T00:00:00.000Z')
    `;

    connect.users.get("bea")!.active = false;
    yield* TestClock.adjust("25 hours");
    yield* identity.confirmAll;
    assert.isFalse(yield* isLive(mcp.sessionId));
    // Still on the server: an Owner removing them is a separate decision.
    assert.isNotNull(yield* (yield* PersonAccess.PersonAccess).readPerson(owner.personId));
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("leaving clears bindings and requests and ends every sign-in session", () =>
  Effect.gen(function* () {
    const identity = yield* Identity.Identity;
    const people = yield* PersonAccess.PersonAccess;
    yield* joined;
    const adaId = yield* grantAda;
    const sessionId = yield* pairedBrowser("ada");
    yield* addUser("grace", "Grace");
    yield* signIn("grace");

    yield* identity.leave;
    assert.isFalse(yield* isLive(sessionId));
    assert.deepStrictEqual(yield* identity.state, { connect: null, accounts: [], requests: [] });
    assert.isNull((yield* identity.describe).signIn);
    // The person stays, with what they reach; only sign-in is gone.
    assert.isNotNull(yield* people.readPerson(adaId));
    const notJoined = yield* Effect.flip(identity.startSignIn("http://localhost:3773"));
    assert.strictEqual(notJoined._tag, "IdentityNotJoinedError");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("the confirmation runs once at start and then each hour", () =>
  Effect.gen(function* () {
    const runs = yield* Queue.unbounded<number>();
    let count = 0;
    const counting = Layer.mock(Identity.Identity)({
      confirmAll: Effect.suspend(() => Queue.offer(runs, ++count)).pipe(Effect.asVoid),
    });
    yield* Effect.gen(function* () {
      assert.strictEqual(yield* Queue.take(runs), 1);
      yield* TestClock.adjust("59 minutes");
      assert.strictEqual(yield* Queue.size(runs), 0);
      yield* TestClock.adjust("1 minute");
      assert.strictEqual(yield* Queue.take(runs), 2);
      yield* TestClock.adjust("1 hour");
      assert.strictEqual(yield* Queue.take(runs), 3);
    }).pipe(Effect.provide(Identity.confirmationLayer.pipe(Layer.provide(counting))));
  }),
);
