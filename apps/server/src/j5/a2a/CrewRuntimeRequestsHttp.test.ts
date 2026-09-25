import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import {
  CrewRuntimeRequestConflictError,
  CrewRuntimeRequestNotFoundError,
  CrewRuntimeRequestService,
  type RespondToCrewRuntimeRequestInput,
} from "./CrewRuntimeRequestService.ts";
import { makeCrewRuntimeRequestsHttpRouteLayer } from "./CrewRuntimeRequestsHttp.ts";

const paths = { list: "/raw/crew-requests", respond: "/raw/crew-requests/respond" };
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

it("lists for readers, answers for operators, and maps refusals to 404 and 409", async () => {
  const answers: Array<RespondToCrewRuntimeRequestInput> = [];
  const service = Layer.mock(CrewRuntimeRequestService)({
    list: Effect.succeed([
      {
        threadId,
        requestId: RuntimeRequestId.make("req:1"),
        crewInstanceId: "crew:1",
        crewName: "Release Crew",
        squadronId: "squadron:1",
        seat: "builder",
        threadTitle: "builder",
        createdAt: "2026-09-24T12:00:00.000Z",
        responseCapability: "live" as const,
        request: {
          kind: "approval" as const,
          requestKind: "command" as const,
          detail: "Run the tests?",
          appName: null,
          options: null,
        },
      },
    ]),
    respond: (input) => {
      answers.push(input);
      return input.requestId === "req:1"
        ? answers.filter((entry) => entry.requestId === "req:1").length === 1
          ? Effect.void
          : Effect.fail(new CrewRuntimeRequestConflictError({ detail: "already resolved" }))
        : Effect.fail(
            new CrewRuntimeRequestNotFoundError({ threadId, requestId: input.requestId }),
          );
    },
  });
  const routes = (scopes: ReadonlyArray<string>) =>
    makeCrewRuntimeRequestsHttpRouteLayer(paths).pipe(
      Layer.provide(service),
      Layer.provideMerge(authWith(scopes)),
      Layer.provide(NodeServices.layer),
      Layer.provide(HttpServer.layerServices),
    );
  const operator = HttpRouter.toWebHandler(
    routes([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]),
    { disableLogger: true },
  );
  const reader = HttpRouter.toWebHandler(routes([AuthOrchestrationReadScope]), {
    disableLogger: true,
  });
  const post = (handler: typeof operator, path: string, body: unknown) =>
    handler.handler(
      new Request(`http://environment.test${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
  try {
    const listed = await post(reader, paths.list, {});
    assert.equal(listed.status, 200);
    const body = (await listed.json()) as { requests: Array<{ requestId: string; seat: string }> };
    assert.deepStrictEqual(
      body.requests.map((item) => [item.requestId, item.seat]),
      [["req:1", "builder"]],
    );

    const accepted = { threadId, requestId: "req:1", decision: "accept" };
    assert.equal((await post(reader, paths.respond, accepted)).status, 403);
    assert.equal((await post(operator, paths.respond, accepted)).status, 200);
    assert.equal((await post(operator, paths.respond, accepted)).status, 409);
    assert.equal(
      (await post(operator, paths.respond, { ...accepted, requestId: "req:gone" })).status,
      404,
    );
    assert.equal((await post(operator, paths.respond, { threadId })).status, 400);
    // Each answer carries its own command id, so a repeat is refused rather than deduplicated.
    assert.lengthOf(answers, 3);
    assert.notEqual(answers[0]!.commandId, answers[1]!.commandId);
  } finally {
    await operator.dispose();
    await reader.dispose();
  }
});
