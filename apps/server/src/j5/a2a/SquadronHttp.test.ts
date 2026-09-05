import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  ProjectId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { ConnectionError, SqlError } from "effect/unstable/sql/SqlError";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { SquadronManagementService } from "./SquadronManagementService.ts";
import { squadronHttpRouteLayer } from "./SquadronHttp.ts";
import { SquadronId } from "./contracts.ts";

const projectId = ProjectId.make("project:squadron-http");
const squadronId = SquadronId.make("squadron:squadron-http");

it("lists and creates explicit Squadron project references", async () => {
  const createInputs: Array<{ readonly name: string; readonly projectId: ProjectId }> = [];
  const management = Layer.mock(SquadronManagementService)({
    list: () =>
      Effect.succeed([
        {
          squadron: { id: squadronId, name: "Operations", createdAt: "2026-08-29T21:00:00.000Z" },
          projectIds: [projectId],
        },
      ]),
    create: (input) => {
      createInputs.push(input);
      return Effect.succeed({
        squadron: { id: squadronId, name: input.name, createdAt: "2026-08-29T21:00:00.000Z" },
        projectIds: [input.projectId],
      });
    },
  });
  const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: () =>
      Effect.succeed({
        sessionId: AuthSessionId.make("auth-session:squadron-http"),
        subject: "squadron-http-test",
        method: "bearer-access-token",
        scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      }),
  });
  const routes = squadronHttpRouteLayer.pipe(
    Layer.provide(management),
    Layer.provideMerge(auth),
    Layer.provide(HttpServer.layerServices),
  );
  const { dispose, handler } = HttpRouter.toWebHandler(routes, { disableLogger: true });

  try {
    const listed = await handler(new Request("http://environment.test/api/j5/squadrons"));
    assert.equal(listed.status, 200);
    assert.deepStrictEqual(await listed.json(), {
      squadrons: [
        {
          squadron: { id: squadronId, name: "Operations", createdAt: "2026-08-29T21:00:00.000Z" },
          projectIds: [projectId],
        },
      ],
    });

    const created = await handler(
      new Request("http://environment.test/api/j5/squadrons", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Operations", projectId }),
      }),
    );
    assert.equal(created.status, 201);
    assert.deepStrictEqual(createInputs, [{ name: "Operations", projectId }]);
  } finally {
    await dispose();
  }
});

it("sanitizes and logs unmatched Squadron operation failures", async () => {
  const management = Layer.mock(SquadronManagementService)({
    list: () =>
      Effect.fail(
        new SqlError({
          reason: new ConnectionError({
            cause: new Error("SQLITE driver detail must not reach the client"),
            message: "SQLITE driver detail must not reach the client",
          }),
        }),
      ),
    create: () => Effect.die("not reached"),
  });
  const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: () =>
      Effect.succeed({
        sessionId: AuthSessionId.make("auth-session:squadron-http"),
        subject: "squadron-http-test",
        method: "bearer-access-token",
        scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      }),
  });
  const routes = squadronHttpRouteLayer.pipe(
    Layer.provide(management),
    Layer.provideMerge(auth),
    Layer.provide(HttpServer.layerServices),
  );
  const { dispose, handler } = HttpRouter.toWebHandler(routes, { disableLogger: true });

  try {
    const response = await handler(new Request("http://environment.test/api/j5/squadrons"));
    assert.equal(response.status, 500);
    assert.deepStrictEqual(await response.json(), {
      error: "SquadronOperationError",
      message: "Squadron operation failed.",
    });
  } finally {
    await dispose();
  }
});
