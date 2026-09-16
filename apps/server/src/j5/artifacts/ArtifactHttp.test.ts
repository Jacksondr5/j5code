import {
  ARTIFACT_LIST_PATH,
  ARTIFACT_READ_PATH,
  ARTIFACT_TRASH_PATH,
  AuthOrchestrationOperateScope,
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

it("reads and trashes artifacts through the authenticated project boundary", async () => {
  const projectId = ProjectId.make("project:artifacts-http");
  let scopes: ReadonlyArray<
    typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope
  > = [];
  const trashed: Array<string> = [];
  const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: () =>
      scopes.length > 0
        ? Effect.succeed({
            sessionId: AuthSessionId.make("auth-session:artifacts"),
            subject: "artifacts-test",
            method: "bearer-access-token" as const,
            scopes,
          })
        : Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({})),
  });
  const projects = Layer.mock(ProjectService.ProjectService)({
    getById: () => Effect.succeed(Option.some({ workspaceRoot: "/workspace" } as never)),
  });
  const artifacts = Layer.mock(ArtifactWorkspace)({
    list: (requestedProjectId) =>
      Effect.succeed([
        { path: `${requestedProjectId.slice(8)}/plan.md`, byteLength: 7, modifiedAt: null },
      ]),
    read: ({ projectId: requestedProjectId, relativePath }) =>
      Effect.succeed({
        path: relativePath,
        byteLength: requestedProjectId.length,
        encoding: "utf8" as const,
        content: "# Plan\n",
      }),
    trash: ({ relativePath }) => Effect.sync(() => void trashed.push(relativePath)),
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
    scopes = [AuthOrchestrationReadScope];

    const list = await post(ARTIFACT_LIST_PATH, { projectId });
    assert.equal(list.status, 200);
    assert.deepStrictEqual(await list.json(), {
      entries: [{ path: "artifacts-http/plan.md", byteLength: 7, modifiedAt: null }],
    });

    const read = await post(ARTIFACT_READ_PATH, { projectId, path: "plan.md" });
    assert.equal(read.status, 200);
    assert.deepStrictEqual(await read.json(), {
      path: "plan.md",
      byteLength: 22,
      encoding: "utf8",
      content: "# Plan\n",
    });

    assert.equal((await post(ARTIFACT_TRASH_PATH, { projectId, path: "plan.md" })).status, 403);
    assert.deepStrictEqual(trashed, []);

    scopes = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope];
    const trash = await post(ARTIFACT_TRASH_PATH, { projectId, path: "plan.md" });
    assert.equal(trash.status, 200);
    assert.deepStrictEqual(await trash.json(), { trashed: true });
    assert.deepStrictEqual(trashed, ["plan.md"]);
  } finally {
    await dispose();
  }
});
