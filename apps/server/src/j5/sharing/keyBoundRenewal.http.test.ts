import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAccessTokenType,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { LEVEL_PERMISSIONS } from "@t3tools/contracts/j5";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { makeDpopKey } from "../../auth/dpop.testkit.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../../auth/http.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import { Access } from "./Access.ts";
import { gateEnvironmentAuth } from "./AccessGate.ts";
import { Links } from "./Links.ts";
import * as PersonAccess from "./PersonAccess.ts";
import { peopleLayer, person } from "./test-support/accessHarness.ts";

class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

// The server's auth as it composes it: upstream's, behind J5's gate, over J5's people.
const services = gateEnvironmentAuth(
  EnvironmentAuth.layer.pipe(
    Layer.provideMerge(peopleLayer),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "j5-key-renewal-http-" })),
  ),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const routes = HttpApiBuilder.layer(AuthTestApi).pipe(
  Layer.provide(AuthHttp.layer),
  Layer.provide(AuthHttp.layerAuthenticatedAuth),
  Layer.provideMerge(services),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
);

const ownerDesktop = { sessionId: "session:owner-desktop" as never, subject: "desktop-bootstrap" };

// The web handler runs on its own runtime, so proofs need wall-clock time.
it.live("renews a device-key session J5 ended through upstream's own token endpoint", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const memoMap = yield* Layer.makeMemoMap;
      const context = yield* Layer.buildWithMemoMap(services, memoMap, yield* Effect.scope);
      const key = makeDpopKey();
      const { token } = yield* Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const links = yield* Links;
        const people = yield* PersonAccess.PersonAccess;
        const access = yield* Access;
        const owner = yield* people.firstOwner;
        yield* people.setName({ personId: owner.personId, displayName: "Owner" });
        const who = yield* person("Vera", [{ scope: { kind: "server" }, level: "viewer" }]);
        const link = yield* links.create(ownerDesktop, { kind: "device", personId: who.personId });
        const joined = yield* links.join({ token: link.token, name: undefined, session: null });
        if (joined.kind !== "pair") return yield* Effect.die(joined.kind);
        const paired = yield* auth.exchangeBootstrapCredentialForAccessToken(
          joined.credential,
          undefined,
          { deviceType: "mobile" },
          { proofKeyThumbprint: key.thumbprint },
        );
        yield* access.setLevel({
          personId: who.personId,
          scope: { kind: "server" },
          level: "collaborator",
        });
        return { token: paired.access_token };
      }).pipe(Effect.provideContext(context));

      const random = yield* SecureRandom.SecureRandom;
      const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
        // As upstream's own token-endpoint test: the routes only record proofs through it.
        Context.add(
          ServerSecretStore.ServerSecretStore,
          ServerSecretStore.ServerSecretStore.of({
            get: () => Effect.succeedNone,
            set: () => Effect.void,
            create: () => Effect.void,
            getOrCreateRandom: () => Effect.die("Not used by these routes."),
            remove: () => Effect.void,
          }),
        ),
      );
      const url = "http://127.0.0.1/oauth/token";
      const iat = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
      const renewal = (proof: string) =>
        new Request(url, {
          method: "POST",
          headers: { host: "127.0.0.1", dpop: proof },
          body: new URLSearchParams({
            grant_type: AuthTokenExchangeGrantType,
            subject_token: token,
            subject_token_type: AuthAccessTokenType,
            requested_token_type: AuthAccessTokenType,
          }),
        });
      const renewed = yield* Effect.acquireUseRelease(
        Effect.sync(() => HttpRouter.toWebHandler(routes, { memoMap, disableLogger: true })),
        (environment) =>
          Effect.promise(async () => {
            const otherKey = makeDpopKey();
            const refused = await environment.handler(
              renewal(otherKey.sign({ method: "POST", url, token: "", iat })),
              requestContext,
            );
            expect(refused.status).toBe(401);
            const accepted = await environment.handler(
              renewal(key.sign({ method: "POST", url, token: "", iat })),
              requestContext,
            );
            expect(accepted.status).toBe(200);
            return (await accepted.json()) as {
              readonly access_token: string;
              readonly token_type: string;
            };
          }),
        (environment) => Effect.promise(() => environment.dispose()),
      );
      expect(renewed.token_type).toBe("DPoP");
      const session = yield* SessionStore.SessionStore.pipe(
        Effect.flatMap((sessions) => sessions.verify(renewed.access_token)),
        Effect.provideContext(context),
      );
      expect([...session.scopes].sort()).toEqual([...LEVEL_PERMISSIONS.collaborator].sort());
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
