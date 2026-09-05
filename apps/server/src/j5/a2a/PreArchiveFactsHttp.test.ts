import { AuthOrchestrationReadScope, AuthSessionId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { A2AArchiveFacts, A2AArchiveFactsError } from "./ArchiveFactsService.ts";
import { PRE_ARCHIVE_FACTS_PATH, preArchiveFactsHttpRouteLayer } from "./PreArchiveFactsHttp.ts";

it("returns the pre-archive facts without turning a failed read into a clean archive", async () => {
  const threadId = ThreadId.make("thread:pre-archive-http");
  let failRead = false;
  const archiveFacts = Layer.mock(A2AArchiveFacts)({
    readForThread: (receivedThreadId) =>
      failRead
        ? Effect.fail(
            new A2AArchiveFactsError({
              operation: "read pre-archive facts",
              cause: new Error("placement unavailable"),
            }),
          )
        : Effect.succeed({
            state: "registered" as const,
            threadId: receivedThreadId,
            squadronId: "squadron:pre-archive-http" as never,
            participantId: "agent:pre-archive-http" as never,
            retired: false,
            openExchanges: [],
            placementSubtree: {
              state: "unknown" as const,
              reason: "placement-query-failed" as const,
            },
          }),
  });
  const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: () =>
      Effect.succeed({
        sessionId: AuthSessionId.make("auth-session:pre-archive-http"),
        subject: "pre-archive-http-test",
        method: "bearer-access-token",
        scopes: [AuthOrchestrationReadScope],
      }),
  });
  const routes = preArchiveFactsHttpRouteLayer.pipe(
    Layer.provide(archiveFacts),
    Layer.provideMerge(auth),
    Layer.provide(HttpServer.layerServices),
  );
  const { dispose, handler } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  const request = (body: unknown) =>
    handler(
      new Request(`http://environment.test${PRE_ARCHIVE_FACTS_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  try {
    const success = await request({ threadId });
    assert.equal(success.status, 200);
    assert.deepStrictEqual(await success.json(), {
      state: "registered",
      threadId,
      squadronId: "squadron:pre-archive-http",
      participantId: "agent:pre-archive-http",
      retired: false,
      openExchanges: [],
      placementSubtree: { state: "unknown", reason: "placement-query-failed" },
    });

    failRead = true;
    const failed = await request({ threadId });
    assert.equal(failed.status, 500);
    assert.deepStrictEqual(await failed.json(), {
      error: "A2AArchiveFactsError",
      message: "Pre-archive fact lookup failed.",
    });
  } finally {
    await dispose();
  }
});
