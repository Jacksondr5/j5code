import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { CrewRuntimeRequestService } from "./CrewRuntimeRequestService.ts";
import { makeCrewRuntimeRequestsHttpRouteLayer } from "./CrewRuntimeRequestsHttp.ts";

const paths = { list: "/raw/crew-requests" } as const;
const threadId = ThreadId.make("thread:builder");

const authWith = (scopes: ReadonlyArray<string>) =>
  Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: () =>
      Effect.succeed({
        sessionId: AuthSessionId.make("auth-session:crew-requests"),
        subject: "crew-requests-test",
        method: "bearer-access-token",
        scopes: scopes as never,
      }),
  });

it("lists a live Crew seat's approvals for a reader", async () => {
  const service = Layer.mock(CrewRuntimeRequestService)({
    list: Effect.succeed([
      {
        threadId,
        requestId: RuntimeRequestId.make("req:1"),
        crewInstanceId: "crew:1",
        crewName: "Release Crew",
        projectId: "project:1",
        seat: "builder",
        threadTitle: "builder",
        createdAt: "2026-09-24T12:00:00.000Z",
        requestKind: "command" as const,
        detail: "Run the tests?",
      },
    ]),
  });
  const reader = HttpRouter.toWebHandler(
    makeCrewRuntimeRequestsHttpRouteLayer(paths).pipe(
      Layer.provide(service),
      Layer.provideMerge(authWith([AuthOrchestrationReadScope])),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );
  try {
    const listed = await reader.handler(
      new Request(`http://environment.test${paths.list}`, { method: "POST", body: "{}" }),
    );
    assert.equal(listed.status, 200);
    const body = (await listed.json()) as { requests: Array<{ requestId: string; seat: string }> };
    assert.deepStrictEqual(
      body.requests.map((item) => [item.requestId, item.seat]),
      [["req:1", "builder"]],
    );
  } finally {
    await reader.dispose();
  }
});
