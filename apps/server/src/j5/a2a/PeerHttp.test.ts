import {
  AuthA2APeerScope,
  AuthA2ASendScope,
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthSessionId,
  EnvironmentId,
  ThreadId,
  type AuthClientSession,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import { J5_PEER_API_PATHS, type PeerRecord } from "@t3tools/contracts/j5";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { A2ADeliveryWorker } from "./DeliveryWorker.ts";
import { peerHttpRouteLayer } from "./PeerHttp.ts";
import { RosterService } from "./RosterService.ts";
import {
  A2APeerReceiverNotDeliverableError,
  A2APeerReceiverNotFoundError,
  PeerInboundService,
  type PeerInboundInput,
} from "./PeerInboundService.ts";
import {
  PeerCredentialMismatchError,
  PeerOriginConflictError,
  PeerRegistryService,
  PeerUnreachableError,
  type AddPeerInput,
} from "./PeerRegistryService.ts";

const work = EnvironmentId.make("environment-work");
const home = EnvironmentId.make("environment-home");
const homePeer: PeerRecord = {
  environmentId: home,
  label: "Home",
  origin: "https://home.example:3773",
  credentialExpiresAt: "2036-09-16T00:00:00.000Z",
  inboundSession: "active",
  createdAt: "2026-09-16T00:00:00.000Z",
};

interface IssuedSession {
  readonly subject: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly label: string | undefined;
  readonly ttlDays: number | undefined;
}

const makeHandler = (input: {
  readonly subject: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly issued?: Array<IssuedSession>;
  readonly revoked?: Array<string>;
  readonly existingSessions?: ReadonlyArray<Pick<AuthClientSession, "sessionId" | "subject">>;
  readonly adds?: Array<AddPeerInput>;
  readonly removed?: Array<string>;
  readonly received?: Array<PeerInboundInput>;
  readonly notifications?: { count: number };
}) => {
  const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: () =>
      Effect.succeed({
        sessionId: AuthSessionId.make("auth-session:peer-http"),
        subject: input.subject,
        method: "bearer-access-token",
        scopes: input.scopes,
        expiresAt: DateTime.makeUnsafe("2036-09-16T00:00:00.000Z"),
      }),
    issueSession: (options) =>
      Effect.sync(() => {
        input.issued?.push({
          subject: options?.subject ?? "default",
          scopes: options?.scopes ?? [],
          label: options?.label,
          ttlDays: options?.ttl === undefined ? undefined : Duration.toDays(options.ttl),
        });
        return {
          sessionId: AuthSessionId.make("auth-session:issued"),
          token: "issued-token",
          method: "bearer-access-token" as const,
          scopes: options?.scopes ?? [],
          subject: options?.subject ?? "default",
          client: { deviceType: "bot" as const },
          expiresAt: DateTime.makeUnsafe("2027-01-01T00:00:00.000Z"),
        };
      }),
    listSessions: () =>
      Effect.succeed(
        (input.existingSessions ?? []).map((session) => ({
          ...session,
          scopes: [AuthA2APeerScope],
          method: "bearer-access-token" as const,
          client: { deviceType: "bot" as const },
          issuedAt: DateTime.makeUnsafe("2026-09-01T00:00:00.000Z"),
          expiresAt: DateTime.makeUnsafe("2027-01-01T00:00:00.000Z"),
          lastConnectedAt: null,
          connected: false,
          current: false,
        })),
      ),
    revokeSession: (sessionId) =>
      Effect.sync(() => {
        input.revoked?.push(sessionId);
        return true;
      }),
  });
  const routes = peerHttpRouteLayer.pipe(
    Layer.provide(
      Layer.mock(PeerRegistryService)({
        add: (request) =>
          request.origin === "https://dark.example"
            ? Effect.fail(
                new PeerUnreachableError({ origin: request.origin, reason: "ECONNREFUSED" }),
              )
            : request.origin === "https://conflict.example"
              ? Effect.fail(
                  new PeerOriginConflictError({
                    environmentId: home,
                    recordedOrigin: homePeer.origin,
                    requestedOrigin: request.origin,
                  }),
                )
              : request.origin === "https://other.example"
                ? Effect.fail(
                    new PeerCredentialMismatchError({
                      origin: request.origin,
                      expectedSubject: `peer:${work}`,
                      actualSubject: "peer:environment-elsewhere",
                    }),
                  )
                : Effect.sync(() => {
                    input.adds?.push(request);
                    return { peer: { ...homePeer, origin: request.origin }, created: true };
                  }),
        get: (environmentId) => Effect.succeed(environmentId === home ? homePeer : null),
        list: () => Effect.succeed([homePeer]),
        remove: (environmentId) =>
          Effect.sync(() => {
            input.removed?.push(environmentId);
            return { removed: environmentId === home };
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(PeerInboundService)({
        receive: (request) =>
          request.receiverId === "agent:j5:a2a:thread:ghost"
            ? Effect.fail(new A2APeerReceiverNotFoundError({ participantId: request.receiverId }))
            : request.receiverId.startsWith("human:")
              ? Effect.fail(
                  new A2APeerReceiverNotDeliverableError({
                    participantId: request.receiverId,
                    reason: "human",
                  }),
                )
              : Effect.sync(() => {
                  input.received?.push(request);
                  const replay = (input.received?.length ?? 0) > 1;
                  return { receivedSeq: 12, replay };
                }),
      }),
    ),
    Layer.provide(
      Layer.mock(A2ADeliveryWorker)({
        notify: Effect.sync(() => {
          if (input.notifications) input.notifications.count += 1;
        }),
      }),
    ),
    Layer.provide(
      Layer.mock(RosterService)({
        list: () =>
          Effect.succeed([
            {
              participantId: "agent:j5:a2a:thread:local-triage",
              kind: "agent" as const,
              squadronId: "squadron:work-billing",
              squadronName: "Billing Migration",
              displayName: "Local triage",
              threadId: ThreadId.make("thread:local-triage"),
              archived: false,
              canReceiveMessage: true,
              acceptsUrgency: false,
              liveness: null,
            },
            {
              participantId: "human:jackson",
              kind: "human" as const,
              squadronId: null,
              squadronName: null,
              displayName: "Jackson",
              threadId: null,
              archived: false,
              canReceiveMessage: false,
              acceptsUrgency: true,
              liveness: null,
            },
            {
              participantId: "machine:watchdog",
              kind: "machine" as const,
              squadronId: "squadron:work-billing",
              squadronName: "Billing Migration",
              displayName: "watchdog",
              threadId: null,
              archived: false,
              canReceiveMessage: false,
              acceptsUrgency: false,
              liveness: null,
            },
          ]),
      }),
    ),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(work),
      }),
    ),
    Layer.provideMerge(auth),
    Layer.provide(HttpServer.layerServices),
  );
  return HttpRouter.toWebHandler(routes, { disableLogger: true });
};

const post = (path: string, body: unknown) =>
  new Request(`http://environment.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const get = (path: string) => new Request(`http://environment.test${path}`);

it("answers hello with this environment and the credential's subject, and completes a rotation", async () => {
  const revoked: Array<string> = [];
  const { dispose, handler } = makeHandler({
    subject: `peer:${home}`,
    scopes: [AuthA2APeerScope],
    revoked,
    existingSessions: [
      { sessionId: AuthSessionId.make("auth-session:peer-http"), subject: `peer:${home}` },
      { sessionId: AuthSessionId.make("auth-session:old-home"), subject: `peer:${home}` },
      { sessionId: AuthSessionId.make("auth-session:other"), subject: "peer:environment-other" },
    ],
  });
  try {
    const response = await handler(get(J5_PEER_API_PATHS.hello));
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.environmentId, work);
    assert.equal(body.subject, `peer:${home}`);
    assert.equal(body.credentialExpiresAt, "2036-09-16T00:00:00.000Z");
    assert.isString((body.server as { version: string }).version);
    assert.deepStrictEqual(
      revoked,
      ["auth-session:old-home"],
      "proving the new credential retires the older one for the same peer and nothing else",
    );
  } finally {
    await dispose();
  }
});

it("refuses hello without the peer scope and refuses admin routes to a peer credential", async () => {
  const machine = makeHandler({ subject: "machine:watchdog", scopes: [AuthA2ASendScope] });
  const peer = makeHandler({ subject: `peer:${home}`, scopes: [AuthA2APeerScope] });
  try {
    assert.equal((await machine.handler(get(J5_PEER_API_PATHS.hello))).status, 403);
    assert.equal((await peer.handler(get(J5_PEER_API_PATHS.peers))).status, 403);
    assert.equal(
      (await peer.handler(post(J5_PEER_API_PATHS.credentials, { environmentId: "x" }))).status,
      403,
    );
    assert.equal(
      (
        await peer.handler(
          post(J5_PEER_API_PATHS.peers, { origin: "https://x.example", credential: "t" }),
        )
      ).status,
      403,
    );
    assert.equal(
      (await peer.handler(post(J5_PEER_API_PATHS.remove, { environmentId: home }))).status,
      403,
    );
  } finally {
    await machine.dispose();
    await peer.dispose();
  }
});

it("issues a peer credential bound to the peer's subject with only a2a:peer and a ten-year life, without revoking the one in use", async () => {
  const issued: Array<IssuedSession> = [];
  const revoked: Array<string> = [];
  const { dispose, handler } = makeHandler({
    subject: "admin",
    scopes: [AuthAccessWriteScope],
    issued,
    revoked,
    existingSessions: [
      { sessionId: AuthSessionId.make("auth-session:old-home"), subject: `peer:${home}` },
      { sessionId: AuthSessionId.make("auth-session:other"), subject: "peer:environment-other" },
      { sessionId: AuthSessionId.make("auth-session:web"), subject: "one-time-token" },
    ],
  });
  try {
    const response = await handler(
      post(J5_PEER_API_PATHS.credentials, { environmentId: home, label: "Home" }),
    );
    assert.equal(response.status, 201);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.environmentId, work, "the issuer names itself so the holder can record it");
    assert.equal(body.credential, "issued-token");
    assert.equal(body.subject, `peer:${home}`);
    assert.deepStrictEqual(issued, [
      { subject: `peer:${home}`, scopes: [AuthA2APeerScope], label: "Peer: Home", ttlDays: 3650 },
    ]);
    assert.deepStrictEqual(
      revoked,
      [],
      "the older credential works until the peer proves the new one",
    );

    const self = await handler(post(J5_PEER_API_PATHS.credentials, { environmentId: work }));
    assert.equal(self.status, 400);
    assert.equal(((await self.json()) as { error: string }).error, "peer_is_self");
  } finally {
    await dispose();
  }
});

it("adds a peer through the registry and maps its refusals to stable codes", async () => {
  const adds: Array<AddPeerInput> = [];
  const { dispose, handler } = makeHandler({
    subject: "admin",
    scopes: [AuthAccessWriteScope],
    adds,
  });
  try {
    const created = await handler(
      post(J5_PEER_API_PATHS.peers, {
        origin: "https://home.example:3773",
        credential: "home-token",
        label: "Home",
      }),
    );
    assert.equal(created.status, 201);
    assert.deepStrictEqual(await created.json(), { peer: homePeer, created: true });
    assert.equal(adds.length, 1);
    assert.equal(adds[0]!.credential, "home-token");
    assert.isFalse(adds[0]!.replaceOrigin);
    const moved = await handler(
      post(J5_PEER_API_PATHS.peers, {
        origin: "https://home-moved.example:3773",
        credential: "home-token",
        replaceOrigin: true,
      }),
    );
    assert.equal(moved.status, 201);
    assert.isTrue(adds[1]!.replaceOrigin);

    const cases: ReadonlyArray<{ origin: string; status: number; error: string }> = [
      { origin: "https://dark.example", status: 502, error: "peer_unreachable" },
      { origin: "https://other.example", status: 409, error: "peer_credential_mismatch" },
      { origin: "https://conflict.example", status: 409, error: "peer_origin_conflict" },
      { origin: "https://bad.example/with/path", status: 400, error: "invalid_request" },
      { origin: "ftp://bad.example", status: 400, error: "invalid_request" },
    ];
    for (const testCase of cases) {
      const response = await handler(
        post(J5_PEER_API_PATHS.peers, { origin: testCase.origin, credential: "t" }),
      );
      assert.equal(response.status, testCase.status, testCase.origin);
      assert.equal(((await response.json()) as { error: string }).error, testCase.error);
    }
    assert.equal(adds.length, 2, "refused origins never reach the registry");
  } finally {
    await dispose();
  }
});

it("lists peers with access:read and removes one while revoking the session it held", async () => {
  const revoked: Array<string> = [];
  const removed: Array<string> = [];
  const reader = makeHandler({ subject: "viewer", scopes: [AuthAccessReadScope] });
  const admin = makeHandler({
    subject: "admin",
    scopes: [AuthAccessWriteScope, AuthOrchestrationOperateScope],
    revoked,
    removed,
    existingSessions: [
      { sessionId: AuthSessionId.make("auth-session:home"), subject: `peer:${home}` },
      { sessionId: AuthSessionId.make("auth-session:web"), subject: "one-time-token" },
    ],
  });
  try {
    const listed = await reader.handler(get(J5_PEER_API_PATHS.peers));
    assert.equal(listed.status, 200);
    assert.deepStrictEqual(await listed.json(), { peers: [homePeer] });
    assert.equal(
      (await reader.handler(post(J5_PEER_API_PATHS.remove, { environmentId: home }))).status,
      403,
      "reading does not permit removal",
    );

    const response = await admin.handler(post(J5_PEER_API_PATHS.remove, { environmentId: home }));
    assert.equal(response.status, 200);
    assert.deepStrictEqual(await response.json(), { removed: true, revokedSessions: 1 });
    assert.deepStrictEqual(removed, [home]);
    assert.deepStrictEqual(revoked, ["auth-session:home"]);

    const missing = await admin.handler(
      post(J5_PEER_API_PATHS.remove, { environmentId: "environment-unknown" }),
    );
    assert.deepStrictEqual(await missing.json(), { removed: false, revokedSessions: 0 });
  } finally {
    await reader.dispose();
    await admin.dispose();
  }
});

const delivery = {
  messageId: "message:j5:a2a:one",
  senderId: "agent:j5:a2a:thread:remote-asker",
  receiverId: "agent:j5:a2a:thread:local-triage",
  exchangeId: "exchange:j5:a2a:one",
  correlationId: "correlation:j5:a2a:one",
  exchangeRole: "ask",
  envelopeChannel: "peer",
  text: "What is the incident status?",
  originSquadronId: "squadron:home-support",
  intent: "incident status",
  createdAt: "2026-09-16T10:00:00.000Z",
} as const;

it("accepts a delivery from a recorded peer, stamps its environment, and wakes the worker", async () => {
  const received: Array<PeerInboundInput> = [];
  const notifications = { count: 0 };
  const { dispose, handler } = makeHandler({
    subject: `peer:${home}`,
    scopes: [AuthA2APeerScope],
    received,
    notifications,
  });
  try {
    const first = await handler(post(J5_PEER_API_PATHS.deliver, delivery));
    assert.equal(first.status, 201);
    assert.deepStrictEqual(await first.json(), { accepted: true, receivedSeq: 12, replay: false });
    assert.equal(received.length, 1);
    assert.equal(received[0]!.originEnvironmentId, home, "the origin is the credential's subject");
    assert.equal(received[0]!.intent, "incident status");
    assert.equal(notifications.count, 1);

    const again = await handler(post(J5_PEER_API_PATHS.deliver, delivery));
    assert.equal(again.status, 200);
    assert.deepStrictEqual(await again.json(), { accepted: true, receivedSeq: 12, replay: true });
  } finally {
    await dispose();
  }
});

it("refuses a delivery from a credential whose environment is not a recorded peer or lacks the scope", async () => {
  const stranger = makeHandler({
    subject: "peer:environment-stranger",
    scopes: [AuthA2APeerScope],
  });
  const admin = makeHandler({ subject: "admin", scopes: [AuthAccessWriteScope] });
  const machine = makeHandler({ subject: "machine:watchdog", scopes: [AuthA2ASendScope] });
  try {
    const refused = await stranger.handler(post(J5_PEER_API_PATHS.deliver, delivery));
    assert.equal(refused.status, 403);
    assert.equal(((await refused.json()) as { error: string }).error, "peer_not_registered");
    assert.equal((await admin.handler(post(J5_PEER_API_PATHS.deliver, delivery))).status, 403);
    assert.equal((await machine.handler(post(J5_PEER_API_PATHS.deliver, delivery))).status, 403);
  } finally {
    await stranger.dispose();
    await admin.dispose();
    await machine.dispose();
  }
});

it("maps inbound refusals: unknown receiver 404, a person 403 policy, a malformed body 400", async () => {
  const { dispose, handler } = makeHandler({ subject: `peer:${home}`, scopes: [AuthA2APeerScope] });
  try {
    const ghost = await handler(
      post(J5_PEER_API_PATHS.deliver, { ...delivery, receiverId: "agent:j5:a2a:thread:ghost" }),
    );
    assert.equal(ghost.status, 404);
    assert.equal(((await ghost.json()) as { error: string }).error, "recipient_not_found");

    const person = await handler(
      post(J5_PEER_API_PATHS.deliver, { ...delivery, receiverId: "human:someone" }),
    );
    assert.equal(person.status, 403);
    assert.deepStrictEqual(
      ((await person.json()) as { error: string; reason: string }).reason,
      "A2APeerReceiverNotDeliverableError",
    );

    const malformed = await handler(post(J5_PEER_API_PATHS.deliver, { messageId: "x" }));
    assert.equal(malformed.status, 400);
  } finally {
    await dispose();
  }
});

it("shows a recorded peer only the agents it could address, and nobody else the roster at all", async () => {
  const peer = makeHandler({ subject: `peer:${home}`, scopes: [AuthA2APeerScope] });
  const stranger = makeHandler({
    subject: "peer:environment-stranger",
    scopes: [AuthA2APeerScope],
  });
  const machine = makeHandler({ subject: "machine:watchdog", scopes: [AuthA2ASendScope] });
  try {
    const response = await peer.handler(get(J5_PEER_API_PATHS.roster));
    assert.equal(response.status, 200);
    assert.deepStrictEqual(await response.json(), {
      agents: [
        {
          participantId: "agent:j5:a2a:thread:local-triage",
          squadronId: "squadron:work-billing",
          squadronName: "Billing Migration",
          threadId: "thread:local-triage",
          displayName: "Local triage",
          archived: false,
          canReceiveMessage: true,
        },
      ],
    });
    assert.equal((await stranger.handler(get(J5_PEER_API_PATHS.roster))).status, 403);
    assert.equal((await machine.handler(get(J5_PEER_API_PATHS.roster))).status, 403);
  } finally {
    await peer.dispose();
    await stranger.dispose();
    await machine.dispose();
  }
});
