import { AuthOrchestrationReadScope, AuthSessionId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { ConnectionError, SqlError } from "effect/unstable/sql/SqlError";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { ClientReadsService } from "./ClientReadsService.ts";
import { A2ADeliveryWorker } from "./DeliveryWorker.ts";
import { A2AHumanInbox } from "./HumanInboxService.ts";
import { j5AuthenticatedRoutesLayer } from "./J5AuthenticatedRoutes.ts";
import { A2ALedger } from "./LedgerService.ts";
import { SquadronProjectReferences } from "./SquadronProjectReferences.ts";
import { THREAD_HOMES_PATH } from "./ThreadHomesHttp.ts";
import { ThreadHomesService } from "./ThreadHomesService.ts";
import { ParticipantId, SquadronId } from "./contracts.ts";

it("wires the authenticated aggregate's thread-homes path without a parallel router", async () => {
  const knownThread = ThreadId.make("thread:thread-homes-http:known");
  const nativeThread = ThreadId.make("thread:thread-homes-http:native");
  const received: Array<ReadonlyArray<ThreadId>> = [];
  let authMode: "missing" | "missing-read-scope" | "read" = "missing";
  let shouldFailRead = false;
  const homes = Layer.mock(ThreadHomesService)({
    threadHomes: (threadIds) => {
      received.push(threadIds);
      if (shouldFailRead) {
        return Effect.fail(
          new SqlError({
            reason: new ConnectionError({
              cause: new Error("SQLITE internal connection detail"),
              message: "SQLITE internal connection detail",
            }),
          }),
        );
      }
      return Effect.succeed({
        entries: [
          {
            threadId: knownThread,
            home: {
              kind: "known" as const,
              squadron: {
                id: SquadronId.make("squadron:thread-homes-http"),
                name: "Thread Homes",
              },
            },
          },
          { threadId: nativeThread, home: { kind: "unknown" as const } },
        ],
      });
    },
  });
  const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: () => {
      if (authMode === "missing") {
        return Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}));
      }
      return Effect.succeed({
        sessionId: AuthSessionId.make("auth-session:thread-homes"),
        subject: "thread-homes-test",
        method: "bearer-access-token",
        scopes: authMode === "read" ? [AuthOrchestrationReadScope] : [],
      });
    },
  });
  const routes = j5AuthenticatedRoutesLayer.pipe(
    Layer.provide(homes),
    Layer.provide(
      Layer.mock(ClientReadsService)({
        participantHomes: () => Effect.succeed([]),
        participantIdentities: () => Effect.succeed({ entries: [] }),
        openInboxCount: (personId) =>
          Effect.succeed({
            personId: personId ?? ParticipantId.make("human:thread-homes-http"),
            count: 0,
          }),
      }),
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

  try {
    const request = () =>
      handler(
        new Request(`http://environment.test${THREAD_HOMES_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ threadIds: [knownThread, nativeThread, knownThread] }),
        }),
      );
    const unauthenticated = await request();
    assert.equal(unauthenticated.status, 401);

    authMode = "missing-read-scope";
    const missingReadScope = await request();
    assert.equal(missingReadScope.status, 403);

    authMode = "read";
    const response = await request();
    assert.equal(response.status, 200);
    assert.deepStrictEqual(await response.json(), {
      entries: [
        {
          threadId: knownThread,
          home: {
            kind: "known",
            squadron: { id: "squadron:thread-homes-http", name: "Thread Homes" },
          },
        },
        { threadId: nativeThread, home: { kind: "unknown" } },
      ],
    });
    assert.deepStrictEqual(received, [[knownThread, nativeThread, knownThread]]);

    shouldFailRead = true;
    const failedRead = await request();
    assert.equal(failedRead.status, 500);
    assert.deepStrictEqual(await failedRead.json(), {
      error: "SqlError",
      message: "Thread-home lookup failed.",
    });
  } finally {
    await dispose();
  }
});
