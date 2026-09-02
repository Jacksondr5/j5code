import { AuthOrchestrationReadScope, AuthSessionId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { ClientReadsService } from "./ClientReadsService.ts";
import { A2AArchiveFacts } from "./ArchiveFactsService.ts";
import {
  CLIENT_READS_OPEN_COUNT_PATH,
  CLIENT_READS_PARTICIPANT_HOMES_PATH,
  CLIENT_READS_PARTICIPANT_IDENTITIES_PATH,
  makeClientReadsHttpRouteLayer,
} from "./ClientReadsHttp.ts";
import { A2ADeliveryWorker } from "./DeliveryWorker.ts";
import { A2AHumanPersonIdError } from "./HumanInboxService.ts";
import { A2AHumanInbox } from "./HumanInboxService.ts";
import { A2ALocalOperatorNotFoundError } from "./HumanPersonRegistry.ts";
import { j5AuthenticatedRoutesLayer } from "./J5AuthenticatedRoutes.ts";
import { A2ALedger } from "./LedgerService.ts";
import { A2AParticipantNotFoundError } from "./SendService.ts";
import { SquadronProjectReferences } from "./SquadronProjectReferences.ts";
import { ThreadHomesService } from "./ThreadHomesService.ts";
import { ParticipantId, SquadronId } from "./contracts.ts";

const paths = {
  participantHome: "/raw-client-reads/home",
  participantIdentities: "/raw-client-reads/identities",
  openInboxCount: "/raw-client-reads/open-count",
} as const;

it("keeps B3 identity requests exact, ordered, and total before aggregate registration", async () => {
  const alpha = ParticipantId.make("agent:client-reads:alpha");
  const unknown = ParticipantId.make("agent:client-reads:unknown");
  const received: Array<ReadonlyArray<ParticipantId>> = [];
  const homesReceived: Array<ReadonlyArray<ThreadId>> = [];
  const clientReads = Layer.mock(ClientReadsService)({
    threadHomes: (threadIds) => {
      homesReceived.push(threadIds);
      return Effect.succeed(
        Array.from(new Set(threadIds)).map((threadId) => ({
          threadId,
          home: {
            kind: "known" as const,
            squadron: { id: SquadronId.make("squadron:client-reads"), name: "Client Reads" },
          },
        })),
      );
    },
    participantIdentities: ({ participantIds }) => {
      received.push(participantIds);
      return Effect.succeed({
        entries: [
          { participantId: unknown, identity: { kind: "unknown" as const } },
          {
            participantId: alpha,
            identity: { kind: "known" as const, displayName: "Alpha" },
          },
        ],
      });
    },
    openInboxCount: (personId) => Effect.succeed({ personId: personId ?? alpha, count: 3 }),
  });
  const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: () =>
      Effect.succeed({
        sessionId: AuthSessionId.make("auth-session:client-reads"),
        subject: "client-reads-test",
        method: "bearer-access-token",
        scopes: [AuthOrchestrationReadScope],
      }),
  });
  const routes = makeClientReadsHttpRouteLayer(paths).pipe(
    Layer.provide(clientReads),
    Layer.provideMerge(auth),
    Layer.provide(HttpServer.layerServices),
  );
  const { dispose, handler } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  try {
    const identities = await handler(
      new Request(`http://environment.test${paths.participantIdentities}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ participantIds: [unknown, alpha, unknown] }),
      }),
    );
    assert.equal(identities.status, 200);
    assert.deepStrictEqual(received, [[unknown, alpha, unknown]]);
    assert.deepStrictEqual(await identities.json(), {
      entries: [
        { participantId: unknown, identity: { kind: "unknown" } },
        { participantId: alpha, identity: { kind: "known", displayName: "Alpha" } },
      ],
    });
    const homes = await handler(
      new Request(`http://environment.test${paths.participantHome}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadIds: ["thread:unknown", "thread:alpha", "thread:unknown"] }),
      }),
    );
    assert.equal(homes.status, 200);
    assert.deepStrictEqual(homesReceived, [
      [
        ThreadId.make("thread:unknown"),
        ThreadId.make("thread:alpha"),
        ThreadId.make("thread:unknown"),
      ],
    ]);
    assert.deepStrictEqual(await homes.json(), {
      entries: [
        {
          threadId: "thread:unknown",
          home: {
            kind: "known",
            squadron: { id: "squadron:client-reads", name: "Client Reads" },
          },
        },
        {
          threadId: "thread:alpha",
          home: {
            kind: "known",
            squadron: { id: "squadron:client-reads", name: "Client Reads" },
          },
        },
      ],
    });
    const count = await handler(
      new Request(`http://environment.test${paths.openInboxCount}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ personId: unknown }),
      }),
    );
    assert.equal(count.status, 200);
    assert.deepStrictEqual(await count.json(), { personId: unknown, count: 3 });
  } finally {
    await dispose();
  }
});

it("maps A4 resolver failures without treating a bad person selection as a server outage", async () => {
  const invalidPerson = ParticipantId.make("agent:client-reads:not-human");
  const missingPerson = ParticipantId.make("human:client-reads:missing");
  const clientReads = Layer.mock(ClientReadsService)({
    threadHomes: () => Effect.succeed([]),
    participantIdentities: () => Effect.succeed({ entries: [] }),
    openInboxCount: (personId) => {
      if (personId === invalidPerson) {
        return Effect.fail(new A2AHumanPersonIdError({ personId }));
      }
      if (personId === missingPerson) {
        return Effect.fail(new A2AParticipantNotFoundError({ participantId: personId }));
      }
      return Effect.fail(new A2ALocalOperatorNotFoundError());
    },
  });
  const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: () =>
      Effect.succeed({
        sessionId: AuthSessionId.make("auth-session:client-reads-errors"),
        subject: "client-reads-errors-test",
        method: "bearer-access-token",
        scopes: [AuthOrchestrationReadScope],
      }),
  });
  const routes = makeClientReadsHttpRouteLayer(paths).pipe(
    Layer.provide(clientReads),
    Layer.provideMerge(auth),
    Layer.provide(HttpServer.layerServices),
  );
  const { dispose, handler } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  const count = (personId?: ParticipantId) =>
    handler(
      new Request(`http://environment.test${paths.openInboxCount}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(personId === undefined ? {} : { personId }),
      }),
    );
  try {
    const invalid = await count(invalidPerson);
    assert.equal(invalid.status, 400);
    assert.deepStrictEqual(await invalid.json(), {
      error: "A2AHumanPersonIdError",
      message:
        "Person agent:client-reads:not-human is not a durable human:<person-id>. Select an explicit person-scoped inbox.",
    });
    const missing = await count(missingPerson);
    assert.equal(missing.status, 404);
    assert.deepStrictEqual(await missing.json(), {
      error: "A2AParticipantNotFoundError",
      message:
        "Participant human:client-reads:missing is not currently reachable. Call list_participants and choose a row with canReceiveMessage=true.",
    });
    const absentLocalOperator = await count();
    assert.equal(absentLocalOperator.status, 404);
    assert.deepStrictEqual(await absentLocalOperator.json(), {
      error: "A2ALocalOperatorNotFoundError",
      message: "The host-local human operator registry entry is missing.",
    });
  } finally {
    await dispose();
  }
});

it("executes home response validation before serializing a malformed Squadron name", async () => {
  const participantId = ParticipantId.make("agent:client-reads:bad-squadron");
  const clientReads = Layer.mock(ClientReadsService)({
    threadHomes: () =>
      Effect.succeed([
        {
          threadId: ThreadId.make("thread:client-reads:bad-squadron"),
          home: {
            kind: "known" as const,
            squadron: { id: SquadronId.make("squadron:client-reads:bad"), name: "   " },
          },
        },
      ]),
    participantIdentities: () => Effect.succeed({ entries: [] }),
    openInboxCount: () => Effect.succeed({ personId: participantId, count: 0 }),
  });
  const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: () =>
      Effect.succeed({
        sessionId: AuthSessionId.make("auth-session:client-reads-malformed"),
        subject: "client-reads-malformed-test",
        method: "bearer-access-token",
        scopes: [AuthOrchestrationReadScope],
      }),
  });
  const routes = makeClientReadsHttpRouteLayer(paths).pipe(
    Layer.provide(clientReads),
    Layer.provideMerge(auth),
    Layer.provide(HttpServer.layerServices),
  );
  const { dispose, handler } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  try {
    const response = await handler(
      new Request(`http://environment.test${paths.participantHome}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadIds: ["thread:malformed"] }),
      }),
    );
    assert.equal(response.status, 500);
    const malformedBody = (await response.json()) as {
      readonly error: string;
      readonly message: string;
    };
    assert.equal(malformedBody.error, "SchemaError");
    assert.equal(malformedBody.message, "Client read failed.");
  } finally {
    await dispose();
  }
});

it("registers B6 client reads through the authenticated aggregate", async () => {
  const known = ParticipantId.make("agent:client-reads:aggregate-known");
  const unknown = ParticipantId.make("agent:client-reads:aggregate-unknown");
  const personId = ParticipantId.make("human:client-reads:aggregate");
  const calls: Array<ReadonlyArray<ParticipantId>> = [];
  let authMode: "missing" | "missing-read-scope" | "read" = "missing";
  const clientReads = Layer.mock(ClientReadsService)({
    threadHomes: (threadIds) =>
      Effect.succeed(
        Array.from(new Set(threadIds)).map((threadId) => ({
          threadId,
          home:
            threadId === ThreadId.make("thread:client-reads:aggregate-unknown")
              ? { kind: "unknown" as const }
              : {
                  kind: "known" as const,
                  squadron: {
                    id: SquadronId.make("squadron:client-reads:aggregate"),
                    name: "Aggregate Squadron",
                  },
                },
        })),
      ),
    participantIdentities: ({ participantIds }) => {
      calls.push(participantIds);
      return Effect.succeed({
        entries: Array.from(new Set(participantIds)).map((participantId) => ({
          participantId,
          identity:
            participantId === unknown
              ? { kind: "unknown" as const }
              : { kind: "known" as const, displayName: "Aggregate Known" },
        })),
      });
    },
    openInboxCount: (requestedPersonId) =>
      Effect.succeed({ personId: requestedPersonId ?? personId, count: 2 }),
  });
  const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: () => {
      if (authMode === "missing") {
        return Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}));
      }
      return Effect.succeed({
        sessionId: AuthSessionId.make("auth-session:client-reads-aggregate"),
        subject: "client-reads-aggregate-test",
        method: "bearer-access-token",
        scopes: authMode === "read" ? [AuthOrchestrationReadScope] : [],
      });
    },
  });
  const routes = j5AuthenticatedRoutesLayer.pipe(
    Layer.provide(clientReads),
    Layer.provide(
      Layer.mock(A2AArchiveFacts)({
        readForThread: (threadId) =>
          Effect.succeed({
            state: "not-an-a2a-participant" as const,
            threadId,
            openExchanges: [],
            placementSubtree: { state: "not-applicable" as const },
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(ThreadHomesService)({ threadHomes: () => Effect.succeed({ entries: [] }) }),
    ),
    Layer.provide(Layer.mock(A2AHumanInbox)({})),
    Layer.provide(Layer.mock(A2ADeliveryWorker)({})),
    Layer.provide(Layer.mock(A2ALedger)({})),
    Layer.provide(Layer.mock(SquadronProjectReferences)({})),
    Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provide(NodeSqliteClient.layerMemory()),
    Layer.provideMerge(auth),
    Layer.provide(HttpServer.layerServices),
  );
  const { dispose, handler } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  const request = (path: string, body: unknown) =>
    handler(
      new Request(`http://environment.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  try {
    assert.equal((await request(CLIENT_READS_OPEN_COUNT_PATH, {})).status, 401);

    authMode = "missing-read-scope";
    assert.equal((await request(CLIENT_READS_OPEN_COUNT_PATH, {})).status, 403);

    authMode = "read";
    const identities = await request(CLIENT_READS_PARTICIPANT_IDENTITIES_PATH, {
      participantIds: [unknown, known, unknown],
    });
    assert.equal(identities.status, 200);
    assert.deepStrictEqual(calls, [[unknown, known, unknown]]);
    assert.deepStrictEqual(await identities.json(), {
      entries: [
        { participantId: unknown, identity: { kind: "unknown" } },
        {
          participantId: known,
          identity: { kind: "known", displayName: "Aggregate Known" },
        },
      ],
    });

    const homes = await request(CLIENT_READS_PARTICIPANT_HOMES_PATH, {
      threadIds: ["thread:client-reads:aggregate-unknown", "thread:client-reads:aggregate-known"],
    });
    assert.equal(homes.status, 200);
    assert.deepStrictEqual(await homes.json(), {
      entries: [
        { threadId: "thread:client-reads:aggregate-unknown", home: { kind: "unknown" } },
        {
          threadId: "thread:client-reads:aggregate-known",
          home: {
            kind: "known",
            squadron: {
              id: "squadron:client-reads:aggregate",
              name: "Aggregate Squadron",
            },
          },
        },
      ],
    });

    const count = await request(CLIENT_READS_OPEN_COUNT_PATH, { personId });
    assert.equal(count.status, 200);
    assert.deepStrictEqual(await count.json(), { personId, count: 2 });
  } finally {
    await dispose();
  }
});
