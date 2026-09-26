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
import { SquadronNotFoundError } from "./LedgerService.ts";
import {
  SquadronDeleteBlockedError,
  SquadronDeleteIncompleteError,
  SquadronManagementService,
  SquadronNameRequiredError,
} from "./SquadronManagementService.ts";
import { squadronHttpRouteLayer } from "./SquadronHttp.ts";
import { SquadronId } from "./contracts.ts";

const projectId = ProjectId.make("project:squadron-http");
const squadronId = SquadronId.make("squadron:squadron-http");

it("allows read-only connections to list Squadrons but rejects creation", async () => {
  const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: () =>
      Effect.succeed({
        sessionId: AuthSessionId.make("auth-session:readonly-squadrons"),
        subject: "read-only-test",
        method: "bearer-access-token",
        scopes: [AuthOrchestrationReadScope],
      }),
  });
  const routes = squadronHttpRouteLayer.pipe(
    Layer.provide(
      Layer.mock(SquadronManagementService)({
        list: () => Effect.succeed([]),
        create: () => Effect.die("Read-only creation reached the service"),
        rename: () => Effect.die("Read-only rename reached the service"),
        delete: () => Effect.die("Read-only delete reached the service"),
      }),
    ),
    Layer.provideMerge(auth),
    Layer.provide(HttpServer.layerServices),
  );
  const { dispose, handler } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  try {
    assert.equal((await handler(new Request("http://remote.test/api/j5/squadrons"))).status, 200);
    const created = await handler(
      new Request("http://remote.test/api/j5/squadrons", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Operations", projectId }),
      }),
    );
    assert.equal(created.status, 403);
    const renamed = await handler(
      new Request(`http://remote.test/api/j5/squadrons/${encodeURIComponent(squadronId)}/rename`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Renamed" }),
      }),
    );
    assert.equal(renamed.status, 403);
    const deleted = await handler(
      new Request(`http://remote.test/api/j5/squadrons/${encodeURIComponent(squadronId)}/delete`, {
        method: "POST",
      }),
    );
    assert.equal(deleted.status, 403);
  } finally {
    await dispose();
  }
});

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
    rename: () => Effect.die("not reached"),
    delete: () => Effect.die("not reached"),
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

const operatorAuth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
  authenticateHttpRequest: () =>
    Effect.succeed({
      sessionId: AuthSessionId.make("auth-session:squadron-http"),
      subject: "squadron-http-test",
      method: "bearer-access-token",
      scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
    }),
});

const itemUrl = (id: string, action: "rename" | "delete") =>
  `http://environment.test/api/j5/squadrons/${encodeURIComponent(id)}/${action}`;

it("renames a Squadron by encoded id and maps blank names and unknown ids", async () => {
  const renameInputs: Array<{ readonly squadronId: string; readonly name: string }> = [];
  const management = Layer.mock(SquadronManagementService)({
    list: () => Effect.die("not reached"),
    create: () => Effect.die("not reached"),
    delete: () => Effect.die("not reached"),
    rename: (input) => {
      renameInputs.push(input);
      if (input.squadronId !== squadronId) {
        return Effect.fail(new SquadronNotFoundError({ squadronId: input.squadronId }));
      }
      if (input.name.trim().length === 0) return Effect.fail(new SquadronNameRequiredError());
      return Effect.succeed({
        squadron: {
          id: squadronId,
          name: input.name.trim(),
          createdAt: "2026-08-29T21:00:00.000Z",
        },
        projectIds: [projectId],
      });
    },
  });
  const routes = squadronHttpRouteLayer.pipe(
    Layer.provide(management),
    Layer.provideMerge(operatorAuth),
    Layer.provide(HttpServer.layerServices),
  );
  const { dispose, handler } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  const rename = (id: string, body: string) =>
    handler(
      new Request(itemUrl(id, "rename"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );

  try {
    const renamed = await rename(squadronId, JSON.stringify({ name: " Renamed " }));
    assert.equal(renamed.status, 200);
    assert.deepStrictEqual(await renamed.json(), {
      squadron: {
        squadron: { id: squadronId, name: "Renamed", createdAt: "2026-08-29T21:00:00.000Z" },
        projectIds: [projectId],
      },
    });
    assert.deepStrictEqual(renameInputs, [{ squadronId, name: " Renamed " }]);

    const blank = await rename(squadronId, JSON.stringify({ name: "   " }));
    assert.equal(blank.status, 400);
    assert.deepStrictEqual(await blank.json(), {
      error: "SquadronNameRequiredError",
      message: "A Squadron name is required.",
    });

    const malformed = await rename(squadronId, JSON.stringify({ title: "nope" }));
    assert.equal(malformed.status, 400);
    assert.deepStrictEqual(await malformed.json(), {
      error: "invalid_request",
      message: "A Squadron name is required.",
    });

    const missing = await rename("squadron:missing", JSON.stringify({ name: "Ghost" }));
    assert.equal(missing.status, 404);
    assert.deepStrictEqual(await missing.json(), {
      error: "SquadronNotFoundError",
      message: "Squadron squadron:missing does not exist.",
    });
  } finally {
    await dispose();
  }
});

it("deletes a Squadron, passes force through, and reports 409 with the blocker when refused", async () => {
  const deleted: Array<{ readonly id: string; readonly force: boolean | undefined }> = [];
  const blockedId = SquadronId.make("squadron:blocked");
  const partialId = SquadronId.make("squadron:partial");
  const management = Layer.mock(SquadronManagementService)({
    list: () => Effect.die("not reached"),
    create: () => Effect.die("not reached"),
    rename: () => Effect.die("not reached"),
    delete: (id, options) => {
      if (id === partialId) {
        return Effect.fail(
          new SquadronDeleteIncompleteError({ squadronId: id, cause: "provider unavailable" }),
        );
      }
      if (id === blockedId) {
        return Effect.fail(
          new SquadronDeleteBlockedError({
            squadronId: id,
            name: "Ops",
            blockers: [
              { kind: "agents", count: 2 },
              { kind: "crews", count: 1 },
            ],
          }),
        );
      }
      if (id !== squadronId) return Effect.fail(new SquadronNotFoundError({ squadronId: id }));
      deleted.push({ id, force: options?.force });
      return Effect.void;
    },
  });
  const routes = squadronHttpRouteLayer.pipe(
    Layer.provide(management),
    Layer.provideMerge(operatorAuth),
    Layer.provide(HttpServer.layerServices),
  );
  const { dispose, handler } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  const remove = (id: string, body?: unknown) =>
    handler(
      new Request(itemUrl(id, "delete"), {
        method: "POST",
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      }),
    );

  try {
    const ok = await remove(squadronId);
    assert.equal(ok.status, 200);
    assert.deepStrictEqual(await ok.json(), { deleted: true, squadronId });
    const forced = await remove(squadronId, { force: true });
    assert.equal(forced.status, 200);
    assert.deepStrictEqual(deleted, [
      { id: squadronId, force: false },
      { id: squadronId, force: true },
    ]);
    const invalid = await remove(squadronId, { force: "yes" });
    assert.equal(invalid.status, 400);

    const blocked = await remove(blockedId);
    assert.equal(blocked.status, 409);
    assert.deepStrictEqual(await blocked.json(), {
      error: "SquadronDeleteBlockedError",
      message:
        'Squadron "Ops" cannot be deleted while it still has 2 active agents and 1 unarchived Crew.',
    });

    const missing = await remove("squadron:missing");
    assert.equal(missing.status, 404);

    const partial = await remove(partialId, { force: true });
    assert.equal(partial.status, 500);
    assert.deepStrictEqual(await partial.json(), {
      error: "SquadronDeleteIncompleteError",
      message: "Deleting the Squadron stopped partway. Try again to finish.",
    });
  } finally {
    await dispose();
  }
});
