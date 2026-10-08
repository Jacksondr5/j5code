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
import {
  J5_PEER_API_PATHS,
  PEER_POLL_MAX_ACKS,
  PEER_PROTOCOL_VERSION,
  PEER_REFUSAL_CODE_MAX_CHARS,
  PEER_ROSTER_MAX_AGENTS,
  type PeerRecord,
} from "@t3tools/contracts/j5";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerConfig } from "../../config.ts";
import { A2ADeliveryWorker } from "./DeliveryWorker.ts";
import { peerHttpRouteLayer } from "./PeerHttp.ts";
import { RosterService } from "./RosterService.ts";
import { PeerStoreService, type PeerPollInput } from "./PeerStoreService.ts";
import {
  A2APeerReceiverNotDeliverableError,
  A2APeerReceiverNotFoundError,
  PeerInboundService,
  type PeerInboundInput,
} from "./PeerInboundService.ts";
import {
  PeerCredentialMismatchError,
  PeerLinkModeConflictError,
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
  linkMode: "push",
  origin: "https://home.example:3773",
  credentialExpiresAt: "2036-09-16T00:00:00.000Z",
  inboundSession: "active",
  createdAt: "2026-09-16T00:00:00.000Z",
  lastPolledAt: null,
  lastError: null,
  waitingCount: 0,
  oldestWaitingAt: null,
};

const laptop = EnvironmentId.make("environment-laptop");
const laptopPeer: PeerRecord = {
  ...homePeer,
  environmentId: laptop,
  label: "JM-LT-04213",
  linkMode: "store",
  origin: null,
  credentialExpiresAt: null,
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
  readonly polls?: Array<PeerPollInput>;
  /** Holds each poll's body until it is released. */
  readonly pollHeld?: Promise<void>;
  readonly grants?: Array<string>;
  /** Environments recorded as store peers by their first proof. */
  readonly adoptions?: Array<string>;
  /** Each origin the probe route hands to the registry. */
  readonly probes?: Array<string>;
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
        probe: (origin) =>
          Effect.sync(() => {
            input.probes?.push(origin);
            return {
              outcome: "reached" as const,
              origin,
              environmentId: "environment-vm",
              label: "Work VM",
            };
          }),
        add: (request) =>
          request.origin === "https://dark.example"
            ? Effect.fail(
                new PeerUnreachableError({ origin: request.origin, reason: "ECONNREFUSED" }),
              )
            : request.origin === "https://conflict.example"
              ? Effect.fail(
                  new PeerOriginConflictError({
                    environmentId: home,
                    recordedOrigin: homePeer.origin!,
                    requestedOrigin: request.origin,
                    credentialKept: false,
                  }),
                )
              : request.origin === "https://polls-here.example"
                ? Effect.fail(
                    new PeerLinkModeConflictError({
                      environmentId: laptop,
                      recorded: "store",
                      requested: "push",
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
        get: (environmentId) =>
          Effect.succeed(
            environmentId === home ? homePeer : environmentId === laptop ? laptopPeer : null,
          ),
        selfEnvironmentId: Effect.succeed(work),
        selfLabel: Effect.succeed("Work VM"),
        adoptStorePeer: ({ environmentId }) =>
          Effect.sync(() => {
            input.adoptions?.push(environmentId);
            return environmentId === home || environmentId === laptop;
          }),
        grantStore: ({ environmentId }) =>
          Effect.sync(() => {
            input.grants?.push(environmentId);
          }),
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
      Layer.mock(PeerStoreService)({
        startPoll: (request) =>
          Effect.sync(() => {
            input.polls?.push(request);
            return Effect.promise(() => input.pollHeld ?? Promise.resolve()).pipe(
              Effect.as({
                deliveries: [],
                rosterHash: "hash-held",
                more: false,
                label: "Work VM",
                capabilities: { poll: true },
              }),
            );
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
    Layer.provideMerge(auth),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "j5-peer-http-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
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
    assert.equal(body.label, "Work VM", "the answering server names itself");
    assert.equal(body.peerProtocolVersion, PEER_PROTOCOL_VERSION);
    assert.deepStrictEqual(body.capabilities, { poll: true }, "this server stores for a poller");
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

it("marks a credential for a peer that will poll, and refuses to change a recorded peer's mode", async () => {
  const issued: Array<IssuedSession> = [];
  const grants: Array<string> = [];
  const { dispose, handler } = makeHandler({
    subject: "admin",
    scopes: [AuthAccessWriteScope],
    issued,
    grants,
  });
  try {
    const fresh = await handler(
      post(J5_PEER_API_PATHS.credentials, { environmentId: "environment-new", store: true }),
    );
    assert.equal(fresh.status, 201);
    assert.deepStrictEqual(grants, ["environment-new"], "the store mark waits for the first proof");

    const rotated = await handler(
      post(J5_PEER_API_PATHS.credentials, { environmentId: laptop, store: true }),
    );
    assert.equal(rotated.status, 201, "a store peer's credential rotates in the same mode");
    assert.deepStrictEqual(grants, ["environment-new"], "a recorded store peer needs no new mark");

    for (const request of [{ environmentId: home, store: true }, { environmentId: laptop }]) {
      const refused = await handler(post(J5_PEER_API_PATHS.credentials, request));
      assert.equal(refused.status, 409);
      const body = (await refused.json()) as { error: string; message: string };
      assert.equal(body.error, "peer_link_mode_conflict");
      assert.include(body.message, "remove the peer and peer again");
    }
    assert.equal(issued.length, 2, "a refused change issues nothing");
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
        // An older client still sends the name it typed; the peer's own name wins.
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
      { origin: "https://polls-here.example", status: 409, error: "peer_link_mode_conflict" },
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

it("refuses a peer on another protocol before reading its request, and states its own on every answer", async () => {
  const received: Array<PeerInboundInput> = [];
  const { dispose, handler } = makeHandler({
    subject: `peer:${home}`,
    scopes: [AuthA2APeerScope],
    received,
  });
  const withProtocol = (request: Request, version: string) => {
    request.headers.set("x-j5-peer-protocol", version);
    return request;
  };
  try {
    for (const request of [
      withProtocol(get(J5_PEER_API_PATHS.hello), "2"),
      withProtocol(get(J5_PEER_API_PATHS.roster), "2"),
      withProtocol(post(J5_PEER_API_PATHS.deliver, delivery), "2"),
    ]) {
      const refused = await handler(request);
      assert.equal(refused.status, 409);
      assert.equal(refused.headers.get("x-j5-peer-protocol"), String(PEER_PROTOCOL_VERSION));
      const body = (await refused.json()) as { error: string; message: string };
      assert.equal(body.error, "peer_protocol_mismatch");
      assert.equal(
        body.message,
        `Peer ${home} runs peer protocol 2 and this server runs 1. Update J5 on this server, then try again.`,
      );
    }
    assert.deepStrictEqual(received, [], "a mismatched delivery is never recorded");

    // A server from before versioning states nothing and counts as version 1.
    const unversioned = await handler(post(J5_PEER_API_PATHS.deliver, delivery));
    assert.equal(unversioned.status, 201);
    assert.equal(unversioned.headers.get("x-j5-peer-protocol"), String(PEER_PROTOCOL_VERSION));
    const matching = await handler(withProtocol(get(J5_PEER_API_PATHS.hello), "1"));
    assert.equal(matching.status, 200);
    assert.equal(matching.headers.get("x-j5-peer-protocol"), String(PEER_PROTOCOL_VERSION));
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
      label: "Work VM",
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

it("hands a storing peer's poll to the store, and refuses a poll from a peer this server sends to", async () => {
  const polls: Array<PeerPollInput> = [];
  // The status and protocol header arrive while the body is still held.
  let release = () => {};
  const pollHeld = new Promise<void>((resolve) => {
    release = resolve;
  });
  const laptopHandler = makeHandler({
    subject: `peer:${laptop}`,
    scopes: [AuthA2APeerScope],
    polls,
    pollHeld,
  });
  try {
    const polled = await laptopHandler.handler(
      post(J5_PEER_API_PATHS.poll, {
        acks: [{ messageId: "message:one", outcome: "received", receivedSeq: 4, replay: false }],
        rosterHash: "hash-laptop",
        label: "JM-LT-04213",
      }),
    );
    assert.equal(polled.status, 200);
    assert.equal(polled.headers.get("x-j5-peer-protocol"), String(PEER_PROTOCOL_VERSION));
    release();
    assert.deepStrictEqual(await polled.json(), {
      deliveries: [],
      rosterHash: "hash-held",
      more: false,
      label: "Work VM",
      capabilities: { poll: true },
    });
    assert.equal(polls.length, 1);
    assert.equal(polls[0]!.environmentId, laptop, "the poller is the credential's subject");
    assert.equal(polls[0]!.protocolVersion, 1, "a poll without the header states version 1");
    assert.equal(polls[0]!.request.acks.length, 1);

    const malformed = await laptopHandler.handler(post(J5_PEER_API_PATHS.poll, { acks: "no" }));
    assert.equal(malformed.status, 400);

    // A poll is bounded: two batches of acks, a short refusal code, a roster of reasonable size.
    const received = (index: number) => ({
      messageId: `message:${String(index)}`,
      outcome: "received",
      receivedSeq: index + 1,
      replay: false,
    });
    const agent = (index: number) => ({
      participantId: `agent:j5:a2a:thread:${String(index)}`,
      squadronId: "squadron:laptop",
      squadronName: "Laptop",
      threadId: `thread:${String(index)}`,
      displayName: null,
      archived: false,
      canReceiveMessage: true,
    });
    for (const oversized of [
      { acks: Array.from({ length: PEER_POLL_MAX_ACKS + 1 }, (_, index) => received(index)) },
      {
        acks: [
          {
            messageId: "message:one",
            outcome: "refused",
            code: "x".repeat(PEER_REFUSAL_CODE_MAX_CHARS + 1),
            message: "No",
          },
        ],
      },
      {
        acks: [],
        roster: Array.from({ length: PEER_ROSTER_MAX_AGENTS + 1 }, (_, index) => agent(index)),
      },
    ]) {
      const bounded = await laptopHandler.handler(
        post(J5_PEER_API_PATHS.poll, { rosterHash: "hash-laptop", ...oversized }),
      );
      assert.equal(bounded.status, 400);
    }
    assert.equal(polls.length, 1, "nothing over the bounds reaches the store");
  } finally {
    await laptopHandler.dispose();
  }

  const homeHandler = makeHandler({ subject: `peer:${home}`, scopes: [AuthA2APeerScope], polls });
  try {
    const refused = await homeHandler.handler(
      post(J5_PEER_API_PATHS.poll, { acks: [], rosterHash: "hash-home" }),
    );
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as { error: string }).error, "peer_not_polling");
    assert.equal(polls.length, 1, "nothing is handed out to a peer this server sends to");
  } finally {
    await homeHandler.dispose();
  }
});

it("refuses a poll without the peer scope, from a stranger, or on another protocol, before the store sees it", async () => {
  const polls: Array<PeerPollInput> = [];
  const adoptions: Array<string> = [];
  const body = {
    acks: [{ messageId: "message:one", outcome: "received", receivedSeq: 4, replay: false }],
    rosterHash: "hash-laptop",
  };
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly subject: string;
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
    readonly protocol?: string;
    readonly status: number;
    readonly error: string;
  }> = [
    {
      name: "a machine token",
      subject: "machine:watchdog",
      scopes: [AuthA2ASendScope],
      status: 403,
      error: "insufficient_scope",
    },
    {
      name: "a peer-scoped session not bound to a peer",
      subject: "admin",
      scopes: [AuthA2APeerScope],
      status: 403,
      error: "peer_subject_required",
    },
    {
      name: "an environment that is not a recorded peer",
      subject: "peer:environment-stranger",
      scopes: [AuthA2APeerScope],
      status: 403,
      error: "peer_not_registered",
    },
    {
      name: "the laptop on another protocol",
      subject: `peer:${laptop}`,
      scopes: [AuthA2APeerScope],
      protocol: "2",
      status: 409,
      error: "peer_protocol_mismatch",
    },
  ];
  for (const testCase of cases) {
    const { dispose, handler } = makeHandler({
      subject: testCase.subject,
      scopes: testCase.scopes,
      polls,
      ...(testCase.protocol === undefined ? {} : { adoptions }),
    });
    try {
      const request = post(J5_PEER_API_PATHS.poll, body);
      if (testCase.protocol !== undefined) {
        request.headers.set("x-j5-peer-protocol", testCase.protocol);
      }
      const refused = await handler(request);
      assert.equal(refused.status, testCase.status, testCase.name);
      // Upstream's scope refusal names its code `code`; the J5 routes name theirs `error`.
      const refusal = (await refused.json()) as { error?: string; code?: string };
      assert.equal(refusal.error ?? refusal.code, testCase.error, testCase.name);
      assert.equal(
        refused.headers.get("x-j5-peer-protocol"),
        String(PEER_PROTOCOL_VERSION),
        `${testCase.name}: every peer answer states this server's protocol`,
      );
    } finally {
      await dispose();
    }
  }
  assert.deepStrictEqual(polls, [], "no refused poll acknowledges or hands out anything");
  assert.deepStrictEqual(adoptions, [], "a poll on another protocol records nothing, as at hello");
});

it("lists this server's own addresses and probes one origin, only for a person who can manage peers", async () => {
  const probes: Array<string> = [];
  for (const scopes of [[AuthA2APeerScope], [AuthAccessReadScope]]) {
    const denied = makeHandler({ subject: "person", scopes, probes });
    try {
      assert.equal((await denied.handler(get(J5_PEER_API_PATHS.addresses))).status, 403);
      const probe = await denied.handler(
        post(J5_PEER_API_PATHS.probe, { origin: "https://vm.example:3773" }),
      );
      assert.equal(probe.status, 403);
    } finally {
      await denied.dispose();
    }
  }
  assert.deepStrictEqual(probes, [], "a refused caller never makes this server fetch anything");

  const admin = makeHandler({ subject: "person", scopes: [AuthAccessWriteScope], probes });
  try {
    const addresses = await admin.handler(get(J5_PEER_API_PATHS.addresses));
    assert.equal(addresses.status, 200);
    // No host is configured here, which reads as loopback only, so no address is offered.
    // peerReachability.test covers what a server bound elsewhere offers.
    assert.deepStrictEqual(await addresses.json(), { origins: [] });

    for (const body of [
      {},
      { origin: "https://vm.example:3773/elsewhere" },
      { origin: "file:///etc/passwd" },
      { origin: "not a url" },
    ]) {
      const refused = await admin.handler(post(J5_PEER_API_PATHS.probe, body));
      assert.equal(refused.status, 400, JSON.stringify(body));
    }
    assert.deepStrictEqual(probes, [], "malformed input is refused before anything is fetched");

    const probed = await admin.handler(
      post(J5_PEER_API_PATHS.probe, { origin: "https://vm.example:3773" }),
    );
    assert.equal(probed.status, 200);
    assert.deepStrictEqual(await probed.json(), {
      outcome: "reached",
      origin: "https://vm.example:3773",
      environmentId: "environment-vm",
      label: "Work VM",
    });
    assert.deepStrictEqual(probes, ["https://vm.example:3773"], "only the origin asked for");
  } finally {
    await admin.dispose();
  }
});
