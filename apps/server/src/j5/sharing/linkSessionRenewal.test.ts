import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { makeDpopKey } from "../../auth/dpop.testkit.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import { gateEnvironmentAuth } from "./AccessGate.ts";
import { Links } from "./Links.ts";
import * as PersonAccess from "./PersonAccess.ts";
import { peopleLayer, person } from "./test-support/accessHarness.ts";

// A J5 link's credential exchanged through upstream's own code, as the server composes it.
const layer = gateEnvironmentAuth(
  EnvironmentAuth.layer.pipe(
    Layer.provideMerge(peopleLayer),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "j5-link-session-" })),
  ),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const requestMetadata = { deviceType: "mobile" as const, os: "iOS", browser: "Safari" };
const ownerDesktop = { sessionId: "session:owner-desktop" as never, subject: "desktop-bootstrap" };

it.layer(layer)("a J5 link's device session", (it) => {
  it.effect("renews in place like upstream's pairing link while the device keeps using it", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const links = yield* Links;
      const people = yield* PersonAccess.PersonAccess;
      const owner = yield* people.firstOwner;
      yield* people.setName({ personId: owner.personId, displayName: "Owner" });
      const priya = yield* person("Priya", [{ scope: { kind: "server" }, level: "viewer" }]);
      const link = yield* links.create(ownerDesktop, { kind: "device", personId: priya.personId });
      const joined = yield* links.join({ token: link.token, name: undefined, session: null });
      assert.strictEqual(joined.kind, "pair");
      if (joined.kind !== "pair") return;

      const key = makeDpopKey();
      const paired = yield* auth.exchangeBootstrapCredentialForAccessToken(
        joined.credential,
        undefined,
        requestMetadata,
        { proofKeyThumbprint: key.thumbprint },
      );
      assert.strictEqual(paired.expires_in, 60 * 60);
      const { sessionId } = yield* sessions.verify(paired.access_token);

      // Past the hour its token lasts: without a renewal window this would be refused.
      yield* TestClock.adjust("2 hours");
      const renewed = yield* auth.renewAccessToken(
        paired.access_token,
        key.thumbprint,
        Effect.void,
      );
      assert.strictEqual((yield* sessions.verify(renewed.access_token)).sessionId, sessionId);
    }),
  );

  it.effect("is cut loose from its person when its device key is revoked", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const links = yield* Links;
      const people = yield* PersonAccess.PersonAccess;
      const sql = yield* SqlClient.SqlClient;
      const owner = yield* people.firstOwner;
      yield* people.setName({ personId: owner.personId, displayName: "Owner" });
      const dana = yield* person("Dana", [{ scope: { kind: "server" }, level: "viewer" }]);
      const link = yield* links.create(ownerDesktop, { kind: "device", personId: dana.personId });
      const joined = yield* links.join({ token: link.token, name: undefined, session: null });
      if (joined.kind !== "pair") return assert.fail(joined.kind);
      const key = makeDpopKey();
      const paired = yield* auth.exchangeBootstrapCredentialForAccessToken(
        joined.credential,
        undefined,
        requestMetadata,
        { proofKeyThumbprint: key.thumbprint },
      );
      const { sessionId } = yield* sessions.verify(paired.access_token);
      const bound = () =>
        sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM j5_a2a_person_session WHERE session_id = ${sessionId}
        `.pipe(Effect.map((rows) => rows[0]?.n ?? 0));
      assert.strictEqual(yield* bound(), 1);

      assert.isTrue(yield* auth.revokeConnectDevice(key.thumbprint));
      assert.strictEqual(yield* bound(), 0);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(sessions.verify(paired.access_token))));
    }),
  );

  it.effect("revoked from another device, takes every session of its key off its person", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const links = yield* Links;
      const people = yield* PersonAccess.PersonAccess;
      const sql = yield* SqlClient.SqlClient;
      const owner = yield* people.firstOwner;
      yield* people.setName({ personId: owner.personId, displayName: "Owner" });
      const pair = Effect.fn("test.pair")(function* (name: string, thumbprint: string) {
        const who = yield* person(name, [{ scope: { kind: "server" }, level: "viewer" }]);
        const link = yield* links.create(ownerDesktop, { kind: "device", personId: who.personId });
        const joined = yield* links.join({ token: link.token, name: undefined, session: null });
        if (joined.kind !== "pair") return yield* Effect.die(joined.kind);
        const paired = yield* auth.exchangeBootstrapCredentialForAccessToken(
          joined.credential,
          undefined,
          requestMetadata,
          { proofKeyThumbprint: thumbprint },
        );
        return (yield* sessions.verify(paired.access_token)).sessionId;
      });
      const phone = makeDpopKey();
      const first = yield* pair("Ola", phone.thumbprint);
      const second = yield* pair("Ola again", phone.thumbprint);
      const caller = yield* pair("Ines", makeDpopKey().thumbprint);
      const bound = (sessionId: string) =>
        sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM j5_a2a_person_session WHERE session_id = ${sessionId}
        `.pipe(Effect.map((rows) => rows[0]?.n ?? 0));

      yield* auth.revokeClientSession(caller, first);
      assert.deepStrictEqual(
        [yield* bound(first), yield* bound(second), yield* bound(caller)],
        [0, 0, 1],
      );
    }),
  );
});
