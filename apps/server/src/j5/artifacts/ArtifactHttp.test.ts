import {
  ARTIFACT_LIST_PATH,
  ARTIFACT_READ_PATH,
  AuthOrchestrationReadScope,
  AuthSessionId,
  ProjectId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { artifactHttpRouteLayer } from "./ArtifactHttp.ts";
import { ArtifactWorkspace } from "./ArtifactWorkspace.ts";

it("reads artifacts through the authenticated project workspace boundary", async () => {
  const projectId = ProjectId.make("project:artifacts-http");
  let authorized = false;
  const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: () =>
      authorized
        ? Effect.succeed({
            sessionId: AuthSessionId.make("auth-session:artifacts"),
            subject: "artifacts-test",
            method: "bearer-access-token" as const,
            scopes: [AuthOrchestrationReadScope],
          })
        : Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({})),
  });
  const projects = Layer.mock(ProjectService.ProjectService)({
    getById: () => Effect.succeed(Option.some({ workspaceRoot: "/workspace" } as never)),
  });
  const artifacts = Layer.mock(ArtifactWorkspace)({
    list: (cwd) =>
      Effect.succeed([{ path: `${cwd.slice(1)}/plan.md`, byteLength: 7, modifiedAt: null }]),
    read: ({ cwd, relativePath }) =>
      Effect.succeed({
        path: relativePath,
        byteLength: cwd.length,
        encoding: "utf8" as const,
        content: "# Plan\n",
      }),
  });
  const routes = artifactHttpRouteLayer.pipe(
    Layer.provide(projects),
    Layer.provide(artifacts),
    Layer.provideMerge(auth),
    Layer.provide(HttpServer.layerServices),
  );
  const { dispose, handler } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  const post = (path: string, body: unknown) =>
    handler(
      new Request(`http://environment.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  try {
    assert.equal((await post(ARTIFACT_LIST_PATH, { projectId })).status, 401);
    authorized = true;

    const list = await post(ARTIFACT_LIST_PATH, { projectId });
    assert.equal(list.status, 200);
    assert.deepStrictEqual(await list.json(), {
      entries: [{ path: "workspace/plan.md", byteLength: 7, modifiedAt: null }],
    });

    const read = await post(ARTIFACT_READ_PATH, { projectId, path: "plan.md" });
    assert.equal(read.status, 200);
    assert.deepStrictEqual(await read.json(), {
      path: "plan.md",
      byteLength: 10,
      encoding: "utf8",
      content: "# Plan\n",
    });
  } finally {
    await dispose();
  }
});
