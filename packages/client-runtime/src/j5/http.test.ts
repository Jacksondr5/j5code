import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

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
  answerHumanExchange,
  createSquadron,
  isJ5UnsupportedError,
  J5HttpError,
  listHumanInbox,
  listSquadrons,
  readOpenInboxCount,
  readThreadPlaybooks,
  readAllPlaybooks,
  readPlaybookLibrary,
} from "./http.ts";

const relayToken = (accessToken: string) =>
  ({ _tag: "Dpop", accessToken, expiresAtEpochMs: 4_102_444_800_000 }) as const;

it.effect("reads each environment's run overview with its own credentials and paging filter", () =>
  Effect.gen(function* () {
    const requests: Request[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ runs: [], total: 101 });
    };
    for (const id of ["alpha", "bravo"]) {
      const response = yield* readAllPlaybooks(
        prepared(id, { _tag: "Bearer", token: `${id}-token` }),
        {
          status: "active",
          offset: 100,
        },
      ).pipe(Effect.provide(remoteHttpClientLayer(fetch)));
      expect(response.total).toBe(101);
    }
    expect(requests.map((request) => [request.url, request.headers.get("authorization")])).toEqual([
      ["https://alpha.test/api/j5/playbooks/runs", "Bearer alpha-token"],
      ["https://bravo.test/api/j5/playbooks/runs", "Bearer bravo-token"],
    ]);
    expect(
      yield* Effect.promise(() => Promise.all(requests.map((request) => request.json()))),
    ).toEqual([
      { status: "active", offset: 100 },
      { status: "active", offset: 100 },
    ]);
  }),
);

it.effect("reads the selected playbook workspace using only its environment credentials", () =>
  Effect.gen(function* () {
    const requests: Request[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ workspaceRoot: "/selected/worktree", playbooks: [] });
    };
    for (const id of ["alpha", "bravo"]) {
      yield* readPlaybookLibrary(prepared(id, { _tag: "Bearer", token: `${id}-token` }), {
        projectId: ProjectId.make("same-project"),
        threadId: ThreadId.make("same-thread"),
      }).pipe(Effect.provide(remoteHttpClientLayer(fetch)));
    }
    expect(requests.map((request) => [request.url, request.headers.get("authorization")])).toEqual([
      ["https://alpha.test/api/j5/playbooks/library", "Bearer alpha-token"],
      ["https://bravo.test/api/j5/playbooks/library", "Bearer bravo-token"],
    ]);
    const bodies = yield* Effect.promise(() =>
      Promise.all(requests.map((request) => request.json())),
    );
    expect(bodies).toEqual([
      { projectId: "same-project", threadId: "same-thread" },
      { projectId: "same-project", threadId: "same-thread" },
    ]);
  }),
);

it.effect("reads playbook progress from the selected thread's environment", () =>
  Effect.gen(function* () {
    const requests: Request[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ runs: [] });
    };
    for (const id of ["alpha", "bravo"]) {
      yield* readThreadPlaybooks(
        prepared(id, { _tag: "Bearer", token: `${id}-token` }),
        ThreadId.make(`${id}-thread`),
      ).pipe(Effect.provide(remoteHttpClientLayer(fetch)));
    }
    expect(requests.map((request) => [request.url, request.headers.get("authorization")])).toEqual([
      ["https://alpha.test/api/j5/playbooks/thread", "Bearer alpha-token"],
      ["https://bravo.test/api/j5/playbooks/thread", "Bearer bravo-token"],
    ]);
    const bodies = yield* Effect.promise(() =>
      Promise.all(requests.map((request) => request.json())),
    );
    expect(bodies).toEqual([{ threadId: "alpha-thread" }, { threadId: "bravo-thread" }]);
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
