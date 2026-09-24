import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  type PreparedConnection,
  type PreparedHttpAuthorization,
} from "../connection/model.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  addPeer,
  answerHumanExchange,
  assignImportedThreads,
  createSquadron,
  issuePeerCredential,
  listPeers,
  removePeer,
  isJ5UnsupportedError,
  J5HttpError,
  listHumanInbox,
  listSquadrons,
  previewCrewProposal,
  readOpenInboxCount,
} from "./http.ts";

const isJ5HttpError = Schema.is(J5HttpError);

const relayToken = (accessToken: string) =>
  ({ _tag: "Dpop", accessToken, expiresAtEpochMs: 4_102_444_800_000 }) as const;

it.effect(
  "assigns imports on the selected owner with its credentials and preserves partial outcomes",
  () =>
    Effect.gen(function* () {
      const requests: Request[] = [];
      const entries = [
        { threadId: "import:one", status: "assigned" },
        { threadId: "import:two", status: "kept_elsewhere" },
        { threadId: "import:three", status: "failed" },
      ];
      const fetch: typeof globalThis.fetch = async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ entries });
      };
      const input = { squadronId: "squadron:bravo", projectId: ProjectId.make("project:bravo") };
      const result = yield* assignImportedThreads(
        prepared("bravo", { _tag: "Bearer", token: "bravo-token" }),
        input,
      ).pipe(Effect.provide(remoteHttpClientLayer(fetch)));
      expect(result.entries).toEqual(entries);
      expect(requests[0]?.url).toBe("https://bravo.test/api/j5/squadrons/assign-imported");
      expect(requests[0]?.headers.get("authorization")).toBe("Bearer bravo-token");
      expect(requests[0]?.method).toBe("POST");
      expect(yield* Effect.promise(() => requests[0]!.json())).toEqual(input);
    }),
);

/** Hands out relay credentials the way the live authorization service does, one per request. */
function relayAuthorization(tokens: ReadonlyArray<string>, httpBaseUrl = "https://relay.test") {
  const issued: Array<{ rejectedAccessToken?: string }> = [];
  let next = 0;
  const service: RemoteEnvironmentAuthorization["Service"] = {
    authorizeBearer: () => Effect.die("bearer authorization is not used by relay reads"),
    authorizeDpop: () => Effect.die("socket authorization is not used by HTTP reads"),
    authorizeDpopHttp: (input) => {
      issued.push(
        input.rejectedAccessToken === undefined
          ? {}
          : { rejectedAccessToken: input.rejectedAccessToken },
      );
      return Effect.succeed({
        environmentId: input.expectedEnvironmentId,
        label: "relay",
        httpBaseUrl,
        httpAuthorization: relayToken(tokens[Math.min(next++, tokens.length - 1)]!),
      });
    },
  };
  return { issued, service };
}

function prepared(id: string, authorization: PreparedHttpAuthorization | null): PreparedConnection {
  const environmentId = EnvironmentId.make(id);
  const label = id;
  const httpBaseUrl = `https://${id}.test`;
  const wsBaseUrl = `wss://${id}.test`;
  return {
    environmentId,
    label,
    httpBaseUrl,
    socketUrl: `${wsBaseUrl}/ws`,
    httpAuthorization: authorization,
    target:
      authorization === null
        ? new PrimaryConnectionTarget({ environmentId, label, httpBaseUrl, wsBaseUrl })
        : authorization._tag === "Bearer"
          ? new BearerConnectionTarget({ environmentId, label, connectionId: id })
          : new RelayConnectionTarget({ environmentId, label }),
  };
}

it.effect("sends each server's own bearer credential and resolves its own person", () =>
  Effect.gen(function* () {
    const requests: Request[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({
        personId: new URL(request.url).hostname === "alpha.test" ? "human:alpha" : "human:bravo",
        items: [],
      });
    };
    const alpha = yield* listHumanInbox(
      prepared("alpha", { _tag: "Bearer", token: "alpha-token" }),
      "open",
    ).pipe(Effect.provide(remoteHttpClientLayer(fetch)));
    const bravo = yield* listHumanInbox(
      prepared("bravo", { _tag: "Bearer", token: "bravo-token" }),
      "open",
    ).pipe(Effect.provide(remoteHttpClientLayer(fetch)));
    expect([alpha.personId, bravo.personId]).toEqual(["human:alpha", "human:bravo"]);
    expect(
      requests.map((request) => [
        new URL(request.url).origin,
        request.headers.get("authorization"),
      ]),
    ).toEqual([
      ["https://alpha.test", "Bearer alpha-token"],
      ["https://bravo.test", "Bearer bravo-token"],
    ]);
    expect(requests.every((request) => !new URL(request.url).searchParams.has("personId"))).toBe(
      true,
    );
  }),
);

it.effect("includes session cookies for the prepared browser environment", () =>
  Effect.gen(function* () {
    const requests: Request[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ squadrons: [] });
    };
    yield* listSquadrons(prepared("browser", null)).pipe(
      Effect.provide(remoteHttpClientLayer(fetch)),
    );
    expect(requests[0]?.credentials).toBe("include");
    expect(requests[0]?.headers.has("authorization")).toBe(false);
  }),
);

it.effect("creates a Squadron and answers an exchange on the selected remote server", () =>
  Effect.gen(function* () {
    const requests: Request[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return new URL(request.url).pathname === "/api/j5/squadrons"
        ? Response.json({
            squadron: {
              squadron: {
                id: "squadron:remote",
                name: "Remote",
                createdAt: "2026-09-08T00:00:00Z",
              },
              projectIds: ["project:remote"],
            },
          })
        : Response.json({
            result: {
              messageId: "message:reply",
              exchangeId: "exchange:remote",
              exchangeState: "closed",
              joinedExistingExchange: false,
              durableAtSeq: 1,
            },
          });
    };
    const remote = prepared("remote", { _tag: "Bearer", token: "remote-token" });
    yield* createSquadron(remote, {
      name: "Remote",
      projectId: ProjectId.make("project:remote"),
    }).pipe(Effect.provide(remoteHttpClientLayer(fetch)));
    const answer = {
      personId: "human:remote",
      exchangeId: "exchange:remote",
      message: "Proceed",
      clientRequestId: "request:stable",
    };
    yield* answerHumanExchange(remote, answer).pipe(Effect.provide(remoteHttpClientLayer(fetch)));
    expect(requests.map((request) => [request.method, new URL(request.url).origin])).toEqual([
      ["POST", "https://remote.test"],
      ["POST", "https://remote.test"],
    ]);
    expect(yield* Effect.promise(() => requests[0]!.json())).toEqual({
      name: "Remote",
      projectId: "project:remote",
    });
    expect(yield* Effect.promise(() => requests[1]!.json())).toEqual(answer);
  }),
);

it.effect("signs fresh DPoP proofs for the actual method and remote URL", () =>
  Effect.gen(function* () {
    const proofs: Array<{ method: string; url: string; accessToken?: string }> = [];
    const requests: Request[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return new URL(request.url).pathname === "/api/j5/squadrons"
        ? Response.json({ squadrons: [] })
        : Response.json({ personId: "human:relay", count: 2 });
    };
    const remote = prepared("relay", relayToken("stale-token"));
    const authorization = relayAuthorization(["relay-token"]);
    yield* Effect.gen(function* () {
      yield* listSquadrons(remote);
      yield* readOpenInboxCount(remote);
    }).pipe(
      Effect.provide(remoteHttpClientLayer(fetch)),
      Effect.provideService(RemoteEnvironmentAuthorization, authorization.service),
      Effect.provideService(ManagedRelayDpopSigner, {
        thumbprint: Effect.succeed("test-thumbprint"),
        createProof: (input) => {
          proofs.push(input);
          return Effect.succeed(`proof-${proofs.length}`);
        },
      }),
    );
    // The token comes from the authorization service at request time, not
    // from the credential captured when the connection was prepared.
    expect(proofs).toEqual([
      { method: "GET", url: "https://relay.test/api/j5/squadrons", accessToken: "relay-token" },
      {
        method: "POST",
        url: "https://relay.test/api/j5/a2a/client-reads/open-count",
        accessToken: "relay-token",
      },
    ]);
    expect(
      requests.map((request) => [
        request.headers.get("authorization"),
        request.headers.get("dpop"),
      ]),
    ).toEqual([
      ["DPoP relay-token", "proof-1"],
      ["DPoP relay-token", "proof-2"],
    ]);
  }),
);

it.effect("refreshes a rejected relay token once and retries the same request", () =>
  Effect.gen(function* () {
    const requests: Request[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return request.headers.get("authorization") === "DPoP fresh-token"
        ? Response.json({ squadrons: [] })
        : Response.json({ code: "auth_invalid", reason: "invalid_credential" }, { status: 401 });
    };
    const authorization = relayAuthorization(["expired-token", "fresh-token"]);
    const squadrons = yield* listSquadrons(prepared("relay", relayToken("expired-token"))).pipe(
      Effect.provide(remoteHttpClientLayer(fetch)),
      Effect.provideService(RemoteEnvironmentAuthorization, authorization.service),
      Effect.provideService(ManagedRelayDpopSigner, {
        thumbprint: Effect.succeed("test-thumbprint"),
        createProof: () => Effect.succeed("proof"),
      }),
    );
    expect(squadrons).toEqual([]);
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
      "DPoP expired-token",
      "DPoP fresh-token",
    ]);
    expect(authorization.issued).toEqual([{}, { rejectedAccessToken: "expired-token" }]);
  }),
);

it.effect("reports a bearer rejection as a J5 error without retrying", () =>
  Effect.gen(function* () {
    const requests: Request[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ message: "Sign in again." }, { status: 401 });
    };
    const error = yield* listSquadrons(prepared("bravo", { _tag: "Bearer", token: "old" })).pipe(
      Effect.provide(remoteHttpClientLayer(fetch)),
      Effect.flip,
    );
    expect(error).toBeInstanceOf(J5HttpError);
    expect(error).toMatchObject({ status: 401, detail: "Sign in again." });
    expect(requests).toHaveLength(1);
  }),
);

it("does not mistake a missing person or rejected credential for a missing J5 route", () => {
  expect(isJ5UnsupportedError(new J5HttpError({ status: 404, detail: "Not found" }))).toBe(true);
  expect(
    isJ5UnsupportedError(
      new J5HttpError({
        status: 404,
        detail: "Missing person",
        code: "A2ALocalOperatorNotFoundError",
      }),
    ),
  ).toBe(false);
  expect(isJ5UnsupportedError(new J5HttpError({ status: 401, detail: "Sign in again" }))).toBe(
    false,
  );
  expect(isJ5UnsupportedError(new J5HttpError({ status: 403, detail: "Read-only" }))).toBe(false);
});

it.effect("previews custom crew seats on their remote environment with its own authorization", () =>
  Effect.gen(function* () {
    const requests: Request[] = [];
    const result = {
      proposalId: "proposal:1",
      approvalToken: "runtime:1",
      seats: [
        {
          seat: "reviewer",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-6-astra",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
          runtimeMode: "full-access",
          provider: "OpenAI",
          harness: "Codex",
          model: "GPT-6-Astra",
          reasoning: "High",
          access: "Full access",
        },
      ],
    };
    const fetch: typeof globalThis.fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json(result);
    };
    const input = {
      proposalId: "proposal:1",
      seats: [
        {
          seat: "reviewer",
          agentId: null,
          reason: "Review",
          instructions: "Check the patch",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-6-astra",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
          runtimeMode: "full-access" as const,
        },
      ],
    };
    const preview = yield* previewCrewProposal(
      prepared("crew-server", { _tag: "Bearer", token: "crew-token" }),
      input,
    ).pipe(Effect.provide(remoteHttpClientLayer(fetch)));
    expect(preview).toEqual(result);
    expect(requests[0]?.url).toBe("https://crew-server.test/api/j5/a2a/crews/proposals/preview");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer crew-token");
    expect(yield* Effect.promise(() => requests[0]!.json())).toEqual(input);
  }),
);

it.effect(
  "drives the peer routes with each server's own credential and decodes their answers",
  () =>
    Effect.gen(function* () {
      const requests: Array<{ url: string; authorization: string | null; body: unknown }> = [];
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        const body = request.method === "POST" ? await request.json() : null;
        const path = new URL(request.url).pathname;
        requests.push({
          url: request.url,
          authorization: request.headers.get("authorization"),
          body,
        });
        if (path === "/api/j5/a2a/peers/credentials") {
          return Response.json(
            {
              environmentId: "environment-work",
              credential: "issued",
              sessionId: "auth-session:peer",
              subject: "peer:environment-home",
              expiresAt: "2027-01-01T00:00:00.000Z",
            },
            { status: 201 },
          );
        }
        if (path === "/api/j5/a2a/peers" && request.method === "POST") {
          return Response.json(
            {
              peer: {
                environmentId: "environment-home",
                label: "Home",
                origin: "https://home.test",
                credentialExpiresAt: "2036-09-16T00:00:00.000Z",
                inboundSession: "active",
                createdAt: "2026-09-16T00:00:00.000Z",
              },
              created: true,
            },
            { status: 201 },
          );
        }
        if (path === "/api/j5/a2a/peers/remove") {
          return Response.json({ removed: true, revokedSessions: 1 });
        }
        return Response.json({ peers: [] });
      };
      const work = prepared("work", { _tag: "Bearer", token: "work-token" });
      const issued = yield* issuePeerCredential(work, {
        environmentId: "environment-home",
        label: "Home",
      }).pipe(Effect.provide(remoteHttpClientLayer(fetch)));
      expect(issued.credential).toBe("issued");
      const added = yield* addPeer(work, {
        origin: "https://home.test",
        credential: "home-issued",
        label: "Home",
      }).pipe(Effect.provide(remoteHttpClientLayer(fetch)));
      expect(added.created).toBe(true);
      expect(added.peer.label).toBe("Home");
      const peers = yield* listPeers(work).pipe(Effect.provide(remoteHttpClientLayer(fetch)));
      expect(peers).toEqual([]);
      const removed = yield* removePeer(work, { environmentId: "environment-home" }).pipe(
        Effect.provide(remoteHttpClientLayer(fetch)),
      );
      expect(removed).toEqual({ removed: true, revokedSessions: 1 });
      expect(
        requests.map((request) => [new URL(request.url).pathname, request.authorization]),
      ).toEqual([
        ["/api/j5/a2a/peers/credentials", "Bearer work-token"],
        ["/api/j5/a2a/peers", "Bearer work-token"],
        ["/api/j5/a2a/peers", "Bearer work-token"],
        ["/api/j5/a2a/peers/remove", "Bearer work-token"],
      ]);
      expect(requests[1]!.body).toEqual({
        origin: "https://home.test",
        credential: "home-issued",
        label: "Home",
      });
    }),
);

it.effect("surfaces the server's peer refusal code and message", () =>
  Effect.gen(function* () {
    const fetch: typeof globalThis.fetch = async () =>
      Response.json(
        { error: "peer_unreachable", message: "Could not reach a J5 server at https://dark.test" },
        { status: 502 },
      );
    const failure = yield* addPeer(prepared("work", { _tag: "Bearer", token: "t" }), {
      origin: "https://dark.test",
      credential: "c",
    }).pipe(Effect.provide(remoteHttpClientLayer(fetch)), Effect.flip);
    expect(isJ5HttpError(failure)).toBe(true);
    if (isJ5HttpError(failure)) {
      expect(failure.code).toBe("peer_unreachable");
      expect(failure.message).toContain("dark.test");
    }
  }),
);
