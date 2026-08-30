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

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import {
  SquadronThreadCreationMissingSquadronError,
  SquadronThreadCreationService,
} from "./SquadronThreadCreationService.ts";
import { SquadronManagementService } from "./SquadronManagementService.ts";
import { squadronHttpRouteLayer } from "./SquadronHttp.ts";
import { SquadronId } from "./contracts.ts";

const projectId = ProjectId.make("project:squadron-http");
const squadronId = SquadronId.make("squadron:squadron-http");

const launchRequest = {
  commandId: "command:squadron-http",
  projectId,
  title: "A new thread",
  modelSelection: { instanceId: "codex", model: "test-model" },
  runtimeMode: "full-access",
  interactionMode: "default",
  workspaceStrategy: { type: "root" },
};

it("lists and creates explicit Squadron project references, then refuses a launch without a Squadron", async () => {
  const createInputs: Array<{ readonly name: string; readonly projectId: ProjectId }> = [];
  const launchInputs: Array<{ readonly squadronId: SquadronId | undefined }> = [];
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
  const creation = Layer.mock(SquadronThreadCreationService)({
    create: (input) => {
      launchInputs.push({ squadronId: input.squadronId });
      return Effect.fail(
        new SquadronThreadCreationMissingSquadronError({
          commandId: "command:squadron-http",
        }),
      );
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
    Layer.provide(creation),
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

    const refused = await handler(
      new Request("http://environment.test/api/j5/squadrons/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(launchRequest),
      }),
    );
    assert.equal(refused.status, 400);
    assert.deepStrictEqual(await refused.json(), {
      error: "SquadronThreadCreationMissingSquadronError",
      message: "Creation command command:squadron-http requires an explicit existing Squadron.",
    });
    assert.deepStrictEqual(launchInputs, [{ squadronId: undefined }]);
  } finally {
    await dispose();
  }
});
