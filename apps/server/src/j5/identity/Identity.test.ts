import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AuthAccessWriteScope, type AuthSessionId } from "@t3tools/contracts";
import { LEVEL_PERMISSIONS } from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { makeDpopKey } from "../../auth/dpop.testkit.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { AuthSessionRepository } from "../../persistence/AuthSessions.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import { Access } from "../sharing/Access.ts";
import * as AccessGate from "../sharing/AccessGate.ts";
import { Links } from "../sharing/Links.ts";
import { PairingIntents } from "../sharing/PairingIntents.ts";
import * as PersonAccess from "../sharing/PersonAccess.ts";
import { makeSessionRenewal } from "../sharing/SessionRenewal.ts";
import { peopleLayer, person } from "../sharing/test-support/accessHarness.ts";
import * as Identity from "./Identity.ts";
import * as FakeConnect from "./test-support/fakeConnect.ts";

/** Holds the gate's one-session revoke at a gate, for the interleaving tests. */
class RevokeGate extends Context.Service<RevokeGate, Ref.Ref<FakeConnect.Gate | null>>()(
  "t3/j5/identity/Identity.test/RevokeGate",
) {}

const gatedRevokes = Layer.effect(
  EnvironmentAuth.EnvironmentAuth,
  Effect.gen(function* () {
    const inner = yield* EnvironmentAuth.EnvironmentAuth;
    const gate = yield* RevokeGate;
    return EnvironmentAuth.EnvironmentAuth.of({
      ...inner,
      revokeSession: (sessionId) =>
        Ref.getAndSet(gate, null).pipe(
          Effect.flatMap((held) =>
            held === null
              ? Effect.void
              : Deferred.succeed(held.entered, undefined).pipe(
                  Effect.andThen(Deferred.await(held.release)),
                ),
          ),
          Effect.andThen(inner.revokeSession(sessionId)),
        ),
    });
  }),
);

// Sign-in as the server composes it, over upstream's real auth and a J5 Connect in-process. The
// hourly loop is left out, so each test runs `confirmAll` itself at the hour it means.
const makeLayer = () =>
  Identity.layer.pipe(
    Layer.provideMerge(gatedRevokes),
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
    Layer.provideMerge(Layer.effect(RevokeGate, Ref.make<FakeConnect.Gate | null>(null))),
    Layer.provideMerge(FakeConnect.layer),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const requestMetadata = { deviceType: "desktop" as const, os: "Linux", browser: "Firefox" };
const phoneMetadata = { deviceType: "mobile" as const, os: "iOS", browser: "Safari" };
const SECOND_ADDRESS = "https://j5.example.test";

/** Joins the fake J5 Connect at two addresses, registering what the first try asks for. */
const joined = Effect.gen(function* () {
  const identity = yield* Identity.Identity;
  const connect = yield* FakeConnect.FakeConnect;
  const join = identity.join({
    issuer: FakeConnect.ISSUER,
    clientId: FakeConnect.CLIENT_ID,
    clientSecret: FakeConnect.CLIENT_SECRET,
    addresses: [SECOND_ADDRESS],
  });
  const first = yield* Effect.flip(join);
  if (first._tag !== "ReturnUrlsNotRegisteredError") return yield* Effect.die(first);
  for (const url of first.toRegister) connect.returnUrls.add(url);
  return yield* join;
});

const firstOrigin = Effect.gen(function* () {
  const identity = yield* Identity.Identity;
  return new URL((yield* identity.state).connect!.returnUrls[0]!).origin;
});

/** Starts a sign-in at `origin` and has J5 Connect sign `subject` in; returns its state and code. */
const startedAs = Effect.fn("test.startedAs")(function* (subject: string, origin?: string) {
  const identity = yield* Identity.Identity;
  const connect = yield* FakeConnect.FakeConnect;
  const at = origin ?? (yield* firstOrigin);
  const url = yield* identity.startSignIn(at);
  return {
    origin: at,
    state: new URL(url).searchParams.get("state")!,
    code: connect.signIn(url, subject),
  };
});

/** One full sign-in by `subject` at the server's first address, as a browser would. */
const signIn = Effect.fn("test.signIn")(function* (subject: string) {
  const identity = yield* Identity.Identity;
  return yield* identity.completeSignIn(yield* startedAs(subject));
});

const addUser = Effect.fn("test.addUser")(function* (subject: string, name: string) {
  const connect = yield* FakeConnect.FakeConnect;
  connect.users.set(subject, { email: `${subject}@example.test`, name, active: true });
});

const credentialFor = Effect.fn("test.credentialFor")(function* (subject: string) {
  const outcome = yield* signIn(subject);
  if (outcome.kind !== "pair") return yield* Effect.die(outcome.kind);
  return outcome.credential;
});

/** A bound account's browser, paired from the credential its sign-in gave. */
const pairedBrowser = Effect.fn("test.pairedBrowser")(function* (subject: string) {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const sessions = yield* SessionStore.SessionStore;
  const paired = yield* auth.createBrowserSession(yield* credentialFor(subject), requestMetadata);
  return {
    sessionId: (yield* sessions.verify(paired.sessionToken)).sessionId,
    token: paired.sessionToken,
  };
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

const grantAs = Effect.fn("test.grantAs")(function* (
  subject: string,
  name: string,
  level: "viewer" | "collaborator" | "owner" = "collaborator",
) {
  const identity = yield* Identity.Identity;
  yield* addUser(subject, name);
  assert.deepStrictEqual(yield* signIn(subject), { kind: "waiting" });
  const request = (yield* identity.state).requests.find(
    (entry) => entry.email === `${subject}@example.test`,
  )!;
  return yield* identity.grant({
    accountId: request.accountId,
    name,
    scope: { kind: "server" },
    level,
  });
});

const grantAda = grantAs("ada", "Ada");

/** Runs the hourly pass `hours` times, an hour apart. */
const passes = Effect.fn("test.passes")(function* (hours: number) {
  const identity = yield* Identity.Identity;
  for (let hour = 0; hour < hours; hour += 1) {
    yield* TestClock.adjust("1 hour");
    yield* identity.confirmAll;
  }
});

const disable = Effect.fn("test.disable")(function* (subject: string) {
  const connect = yield* FakeConnect.FakeConnect;
  connect.users.get(subject)!.active = false;
});

it.effect("joining checks the client's secret and every return address before it trusts", () =>
  Effect.gen(function* () {
    const identity = yield* Identity.Identity;
    const connect = yield* FakeConnect.FakeConnect;
    const join = (clientSecret: string, issuer = FakeConnect.ISSUER) =>
      identity.join({
        issuer,
        clientId: FakeConnect.CLIENT_ID,
        clientSecret,
        addresses: [SECOND_ADDRESS],
      });
    assert.strictEqual(
      (yield* Effect.flip(join("not-the-secret")))._tag,
      "ClientSecretRefusedError",
    );

    const missing = yield* Effect.flip(join(FakeConnect.CLIENT_SECRET));
    if (missing._tag !== "ReturnUrlsNotRegisteredError") return assert.fail(missing._tag);
    assert.include(missing.toRegister, `${SECOND_ADDRESS}/api/j5/identity/callback`);
    assert.isTrue(missing.toRegister.every((url) => url.endsWith("/api/j5/identity/callback")));
    assert.isNull((yield* identity.describe).signIn);

    for (const url of missing.toRegister.slice(1)) connect.returnUrls.add(url);
    const stillMissing = yield* Effect.flip(join(FakeConnect.CLIENT_SECRET));
    if (stillMissing._tag !== "ReturnUrlsNotRegisteredError") return assert.fail(stillMissing._tag);
    assert.deepStrictEqual(stillMissing.missing, missing.toRegister.slice(0, 1));

    // Tokens and codes travel only over HTTPS, or to this machine.
    const plain = yield* Effect.flip(
      join(FakeConnect.CLIENT_SECRET, "http://connect.example.test"),
    );
    assert.strictEqual(plain._tag, "OidcError");
    connect.returnUrls.add(missing.toRegister[0]!);
    // Nor to an endpoint over plain HTTP, even on loopback, under an HTTPS issuer.
    for (const plainHttpEndpoint of ["outside", "loopback"] as const) {
      connect.plainHttpEndpoint = plainHttpEndpoint;
      const refused = yield* Effect.flip(join(FakeConnect.CLIENT_SECRET));
      assert.strictEqual(refused._tag, "OidcError", plainHttpEndpoint);
    }
    connect.plainHttpEndpoint = null;

    const done = yield* join(FakeConnect.CLIENT_SECRET);
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
    yield* addUser("hopper", "Hopper");
    const before = yield* countPeople;

    assert.deepStrictEqual(yield* signIn("grace"), { kind: "waiting" });
    assert.deepStrictEqual(yield* signIn("grace"), { kind: "waiting" });
    const state = yield* identity.state;
    assert.strictEqual(state.requests.length, 1);
    assert.strictEqual(state.requests[0]!.email, "grace@example.test");
    assert.strictEqual(yield* countPeople, before);

    // Declined: "not let in" for a week, and no decision on it is taken twice.
    const graceRequest = state.requests[0]!.accountId;
    yield* identity.decline(graceRequest);
    assert.deepStrictEqual(yield* signIn("grace"), { kind: "not-let-in" });
    assert.strictEqual((yield* identity.state).requests.length, 0);
    const owner = yield* person("Someone", [{ scope: { kind: "server" }, level: "viewer" }]);
    assert.strictEqual(
      (yield* Effect.flip(identity.bind({ accountId: graceRequest, personId: owner.personId })))
        ._tag,
      "AccountNotFoundError",
    );

    // Expired undecided says the same, from when it expired.
    assert.deepStrictEqual(yield* signIn("hopper"), { kind: "waiting" });
    yield* TestClock.adjust("8 days");
    assert.deepStrictEqual(yield* signIn("hopper"), { kind: "not-let-in" });
    assert.deepStrictEqual(yield* signIn("grace"), { kind: "waiting" });
    yield* TestClock.adjust("7 days");
    assert.deepStrictEqual(yield* signIn("hopper"), { kind: "waiting" });
    assert.strictEqual(yield* countPeople, before + 1);
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
    const { sessionId } = yield* pairedBrowser("ada");
    const reach = yield* people.sessionReach({ sessionId, subject: "j5:link" });
    assert.strictEqual(reach.kind === "person" ? reach.person.personId : null, adaId);
    const bound = yield* sql<{ readonly sign_in_account_id: string | null }>`
      SELECT sign_in_account_id FROM j5_a2a_person_session WHERE session_id = ${sessionId}
    `;
    const adaAccount = (yield* (yield* Identity.Identity).state).accounts.find(
      (account) => account.personId === adaId,
    );
    assert.strictEqual(bound[0]?.sign_in_account_id, adaAccount?.accountId);
    assert.isDefined(adaAccount);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("an Owner binds a waiting account to someone here, once each way", () =>
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
    assert.strictEqual(accountTaken._tag, "AccountNotFoundError");

    const { sessionId } = yield* pairedBrowser("lin");
    yield* identity.unbind(lin.personId);
    assert.isFalse(yield* isLive(sessionId));
    assert.strictEqual(
      (yield* Effect.flip(identity.unbind(lin.personId)))._tag,
      "PersonNotBoundError",
    );
    assert.deepStrictEqual(yield* signIn("lin"), { kind: "waiting" });
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("a sign-in's state is used once, at its own address, and a bad token is refused", () =>
  Effect.gen(function* () {
    const identity = yield* Identity.Identity;
    const connect = yield* FakeConnect.FakeConnect;
    yield* joined;
    yield* grantAda;

    const started = yield* startedAs("ada");
    // Back at another registered address: refused, and the sign-in is still there to finish.
    const elsewhere = yield* Effect.flip(
      identity.completeSignIn({ ...started, origin: SECOND_ADDRESS }),
    );
    assert.strictEqual(elsewhere._tag, "SignInElsewhereError");
    assert.strictEqual((yield* identity.completeSignIn(started)).kind, "pair");
    const replay = yield* Effect.flip(identity.completeSignIn(started));
    assert.strictEqual(replay._tag, "SignInExpiredError");

    for (const claims of [
      { iss: "https://elsewhere.example.test" },
      { aud: "another-client" },
      { azp: "another-client" },
      { nonce: "not-the-nonce" },
      { exp: -1000 },
      { nbf: 9_999_999_999 },
    ]) {
      const next = yield* startedAs("ada");
      connect.nextClaims = claims;
      const refused = yield* Effect.flip(identity.completeSignIn(next));
      assert.strictEqual(refused._tag, "OidcError", JSON.stringify(claims));
    }

    const unregistered = yield* Effect.flip(identity.startSignIn("http://198.51.100.7:3773"));
    assert.strictEqual(unregistered._tag, "AddressNotRegisteredError");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("a sign-in J5 Connect answered after a leave records nothing", () =>
  Effect.gen(function* () {
    const identity = yield* Identity.Identity;
    const connect = yield* FakeConnect.FakeConnect;
    const sql = yield* SqlClient.SqlClient;
    yield* joined;
    yield* addUser("grace", "Grace");
    const started = yield* startedAs("grace");
    const gate = yield* FakeConnect.makeGate;
    connect.codeGate = gate;
    const finishing = yield* Effect.forkChild(identity.completeSignIn(started));
    yield* Deferred.await(gate.entered);
    yield* identity.leave;
    yield* Deferred.succeed(gate.release, undefined);
    const exit = yield* Fiber.await(finishing);
    assert.isTrue(Exit.isFailure(exit));
    const accounts = yield* sql`SELECT account_id FROM j5_identity_account`;
    assert.strictEqual(accounts.length, 0);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("nothing from an account pairs or renews once its unbind has begun", () =>
  Effect.gen(function* () {
    const identity = yield* Identity.Identity;
    const access = yield* Access;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const revokeGate = yield* RevokeGate;
    const renewal = makeSessionRenewal({
      sessions: yield* SessionStore.SessionStore,
      repository: yield* AuthSessionRepository,
      people: yield* PersonAccess.PersonAccess,
      sql: yield* SqlClient.SqlClient,
    });
    yield* joined;
    const adaId = yield* grantAda;
    const browser = yield* pairedBrowser("ada");
    const waiting = yield* credentialFor("ada");
    // A change of level ends the browser's session for renewal.
    yield* access.setLevel({ personId: adaId, scope: { kind: "server" }, level: "viewer" });

    const gate = yield* FakeConnect.makeGate;
    yield* Ref.set(revokeGate, gate);
    const unbinding = yield* Effect.forkChild(identity.unbind(adaId));
    yield* Deferred.await(gate.entered);
    // Mid-cleanup: the waiting credential and the renewal are both refused.
    const paired = yield* Effect.exit(auth.createBrowserSession(waiting, requestMetadata));
    assert.isTrue(Exit.isFailure(paired));
    const renewed = yield* Effect.exit(renewal.renewToken(browser.token));
    assert.isTrue(Exit.isFailure(renewed));
    yield* Deferred.succeed(gate.release, undefined);
    yield* Fiber.join(unbinding);
    assert.isFalse(yield* isLive(browser.sessionId));
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("an account J5 Connect keeps confirming keeps its sign-in past a day", () =>
  Effect.gen(function* () {
    yield* joined;
    yield* grantAda;
    const { sessionId } = yield* pairedBrowser("ada");
    yield* passes(30);
    assert.isTrue(yield* isLive(sessionId));
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("an outage shorter than a day changes nothing", () =>
  Effect.gen(function* () {
    const connect = yield* FakeConnect.FakeConnect;
    yield* joined;
    yield* grantAda;
    const { sessionId } = yield* pairedBrowser("ada");
    connect.outage = true;
    yield* passes(23);
    assert.isTrue(yield* isLive(sessionId));
    connect.outage = false;
    yield* passes(24);
    assert.isTrue(yield* isLive(sessionId));
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("a disabled account's sign-in lapses after a day, closing its open socket", () =>
  Effect.gen(function* () {
    const sessions = yield* SessionStore.SessionStore;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    yield* joined;
    yield* grantAda;
    const browser = yield* pairedBrowser("ada");
    const key = makeDpopKey();
    const phone = yield* auth.exchangeBootstrapCredentialForAccessToken(
      yield* credentialFor("ada"),
      undefined,
      phoneMetadata,
      { proofKeyThumbprint: key.thumbprint },
    );
    const phoneSession = (yield* sessions.verify(phone.access_token)).sessionId;
    const socket = yield* Effect.forkChild(sessions.awaitInvalidation(browser.sessionId));

    yield* disable("ada");
    yield* passes(23);
    assert.isTrue(yield* isLive(browser.sessionId));
    yield* passes(1);
    assert.isFalse(yield* isLive(browser.sessionId));
    assert.isFalse(yield* isLive(phoneSession));
    assert.isTrue(Exit.isSuccess(yield* Fiber.await(socket)));

    // Signing in again works only once the company account is active again.
    assert.strictEqual((yield* Effect.flip(signIn("ada")))._tag, "OidcError");
    (yield* FakeConnect.FakeConnect).users.get("ada")!.active = true;
    assert.strictEqual((yield* signIn("ada")).kind, "pair");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("a refresh that carries no ID token confirms nothing", () =>
  Effect.gen(function* () {
    const connect = yield* FakeConnect.FakeConnect;
    yield* joined;
    yield* grantAda;
    const { sessionId } = yield* pairedBrowser("ada");
    connect.refreshWithoutIdToken = true;
    yield* passes(24);
    // The first refresh spent the token without confirming; later ones meet J5 Connect's
    // refusal of a spent token, which looks like an outage, so the lapse comes from the count
    // of passes with no answer.
    assert.isTrue(yield* isLive(sessionId));
    yield* passes(1);
    assert.isFalse(yield* isLive(sessionId));
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("a phone paired from a signed-in browser is that sign-in's; a link's device is not", () =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;
    const intents = yield* PairingIntents;
    const links = yield* Links;
    const identity = yield* Identity.Identity;
    yield* joined;
    const adaId = yield* grantAs("ada", "Ada", "owner");
    const browser = yield* pairedBrowser("ada");
    // An Owner's Connections link, made from the signed-in browser, for a phone.
    const link = yield* auth.createPairingLink({
      scopes: [...LEVEL_PERMISSIONS.owner],
      subject: "one-time-token",
    });
    yield* intents.recordForCreator({
      creator: { sessionId: browser.sessionId, subject: "j5:link" },
      pairingLinkId: link.id,
      credential: link.credential,
      scopes: [...LEVEL_PERMISSIONS.owner],
      creatorLive: Effect.succeed(true),
    });
    const key = makeDpopKey();
    const phone = yield* auth.exchangeBootstrapCredentialForAccessToken(
      link.credential,
      undefined,
      phoneMetadata,
      { proofKeyThumbprint: key.thumbprint },
    );
    const phoneSession = (yield* sessions.verify(phone.access_token)).sessionId;
    // A J5 link for Ada's tablet, on the same device key as a signed-in session there.
    const tabletKey = makeDpopKey();
    const deviceLink = yield* links.create(
      { sessionId: browser.sessionId, subject: "j5:link" },
      { kind: "device", personId: adaId },
    );
    const joinedLink = yield* links.join({
      token: deviceLink.token,
      name: undefined,
      session: null,
    });
    if (joinedLink.kind !== "pair") return assert.fail(joinedLink.kind);
    const tablet = yield* auth.exchangeBootstrapCredentialForAccessToken(
      joinedLink.credential,
      undefined,
      phoneMetadata,
      { proofKeyThumbprint: tabletKey.thumbprint },
    );
    const tabletLinked = (yield* sessions.verify(tablet.access_token)).sessionId;
    const tabletSigned = yield* auth.exchangeBootstrapCredentialForAccessToken(
      yield* credentialFor("ada"),
      undefined,
      phoneMetadata,
      { proofKeyThumbprint: tabletKey.thumbprint },
    );
    const tabletSignedIn = (yield* sessions.verify(tabletSigned.access_token)).sessionId;

    yield* identity.unbind(adaId);
    assert.isFalse(yield* isLive(browser.sessionId));
    assert.isFalse(yield* isLive(phoneSession));
    assert.isFalse(yield* isLive(tabletSignedIn));
    // Only the identity's own sessions end: the link's, on the same key, stays.
    assert.isTrue(yield* isLive(tabletLinked));
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("a bound Owner who never signs in again is confirmed, and lapses when disabled", () =>
  Effect.gen(function* () {
    const identity = yield* Identity.Identity;
    const sessions = yield* SessionStore.SessionStore;
    const sql = yield* SqlClient.SqlClient;
    yield* joined;
    const owner = yield* person("Bea", [{ scope: { kind: "server" }, level: "owner" }]);
    yield* addUser("bea", "Bea");
    yield* signIn("bea");
    const [request] = (yield* identity.state).requests;
    yield* identity.bind({ accountId: request!.accountId, personId: owner.personId });
    const mcp = yield* sessions.issue({
      method: "bearer-access-token",
      subject: "mcp-client",
      scopes: [AuthAccessWriteScope],
    });
    yield* sql`
      INSERT INTO j5_a2a_mcp_client_approver (session_id, person_id, expires_at)
      VALUES (${mcp.sessionId}, ${owner.personId}, '2999-01-01T00:00:00.000Z')
    `;
    // Confirmed from the binding on, though Bea never signs in again.
    yield* passes(30);
    assert.isTrue(yield* isLive(mcp.sessionId));
    assert.isNotNull((yield* identity.state).accounts[0]!.lastConfirmedAt);

    yield* disable("bea");
    yield* passes(24);
    assert.isFalse(yield* isLive(mcp.sessionId));
    // Still on the server: an Owner removing them is a separate decision.
    assert.isNotNull(yield* (yield* PersonAccess.PersonAccess).readPerson(owner.personId));
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("one stalled refresh does not keep another account's sign-in alive", () =>
  Effect.gen(function* () {
    const identity = yield* Identity.Identity;
    const connect = yield* FakeConnect.FakeConnect;
    yield* joined;
    yield* grantAda;
    yield* grantAs("bob", "Bob");
    yield* grantAs("carol", "Carol");
    yield* pairedBrowser("ada");
    const bob = yield* pairedBrowser("bob");
    // Carol's refresh is the answer that tells this pass J5 Connect is up.
    const carol = yield* pairedBrowser("carol");
    yield* disable("bob");
    connect.stall.add("ada");
    connect.stalled = yield* Deferred.make<void>();
    yield* TestClock.adjust("25 hours");
    const pass = yield* Effect.forkChild(identity.confirmAll);
    yield* Deferred.await(connect.stalled);
    yield* TestClock.adjust("16 seconds");
    yield* Fiber.join(pass);
    assert.isFalse(yield* isLive(bob.sessionId));
    assert.isTrue(yield* isLive(carol.sessionId));
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("waking with no network lapses no one; a day of passes with no answer does", () =>
  Effect.gen(function* () {
    const identity = yield* Identity.Identity;
    const connect = yield* FakeConnect.FakeConnect;
    yield* joined;
    yield* grantAda;
    const { sessionId } = yield* pairedBrowser("ada");

    // Asleep for 30 hours, then passes before the network is up, or while J5 Connect only
    // answers with a server error, then one once it answers.
    yield* TestClock.adjust("30 hours");
    connect.down = true;
    yield* identity.confirmAll;
    assert.isTrue(yield* isLive(sessionId));
    connect.down = false;
    connect.discoveryBroken = true;
    yield* identity.confirmAll;
    assert.isTrue(yield* isLive(sessionId));
    connect.discoveryBroken = false;
    // Discovery answers, but every refresh meets an outage: still no answer.
    connect.outage = true;
    yield* identity.confirmAll;
    assert.isTrue(yield* isLive(sessionId));
    connect.outage = false;
    yield* passes(1);
    assert.isTrue(yield* isLive(sessionId));

    // Unreachable for a day of hourly passes: it fails closed on the 24th.
    connect.down = true;
    yield* passes(23);
    assert.isTrue(yield* isLive(sessionId));
    yield* passes(1);
    assert.isFalse(yield* isLive(sessionId));
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("a restart in the middle of an outage keeps counting the passes with no answer", () =>
  Effect.gen(function* () {
    const connect = yield* FakeConnect.FakeConnect;
    yield* joined;
    yield* grantAda;
    const { sessionId } = yield* pairedBrowser("ada");
    connect.down = true;
    yield* passes(12);
    // The server restarts: a new Identity over the same database.
    const restarted = Context.get(yield* Layer.build(Identity.layer), Identity.Identity);
    for (let hour = 0; hour < 11; hour += 1) {
      yield* TestClock.adjust("1 hour");
      yield* restarted.confirmAll;
    }
    assert.isTrue(yield* isLive(sessionId));
    // The 24th pass with no answer, counting those before the restart.
    yield* TestClock.adjust("1 hour");
    yield* restarted.confirmAll;
    assert.isFalse(yield* isLive(sessionId));
  }).pipe(Effect.scoped, Effect.provide(makeLayer())),
);

it.effect("a sign-in without offline access is refused, and an unverified email is not kept", () =>
  Effect.gen(function* () {
    const identity = yield* Identity.Identity;
    const connect = yield* FakeConnect.FakeConnect;
    yield* joined;
    yield* addUser("grace", "Grace");
    connect.withoutOfflineAccess = true;
    const refused = yield* Effect.flip(signIn("grace"));
    assert.strictEqual(refused._tag, "OidcError");
    assert.include(refused.message, "offline access");
    assert.strictEqual((yield* identity.state).requests.length, 0);
    connect.withoutOfflineAccess = false;

    connect.users.set("hopper", {
      email: "hopper@example.test",
      name: "Hopper",
      active: true,
      emailVerified: false,
    });
    assert.deepStrictEqual(yield* signIn("hopper"), { kind: "waiting" });
    const [request] = (yield* identity.state).requests;
    assert.strictEqual(request!.name, "Hopper");
    assert.isNull(request!.email);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("rejoining with another client forgets the accounts; the same client keeps them", () =>
  Effect.gen(function* () {
    const identity = yield* Identity.Identity;
    yield* joined;
    yield* grantAda;
    const { sessionId } = yield* pairedBrowser("ada");
    const rejoin = (clientId: string) =>
      identity.join({
        issuer: FakeConnect.ISSUER,
        clientId,
        clientSecret: FakeConnect.CLIENT_SECRET,
        addresses: [SECOND_ADDRESS],
      });

    yield* rejoin(FakeConnect.CLIENT_ID);
    assert.strictEqual((yield* identity.state).accounts.length, 1);
    assert.isTrue(yield* isLive(sessionId));

    yield* rejoin(FakeConnect.OTHER_CLIENT_ID);
    assert.deepStrictEqual((yield* identity.state).accounts, []);
    assert.isFalse(yield* isLive(sessionId));
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("leaving clears bindings and requests and ends every sign-in session", () =>
  Effect.gen(function* () {
    const identity = yield* Identity.Identity;
    const people = yield* PersonAccess.PersonAccess;
    yield* joined;
    const adaId = yield* grantAda;
    const { sessionId } = yield* pairedBrowser("ada");
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
