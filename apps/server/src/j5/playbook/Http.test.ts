import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSessionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { EnvironmentAuth, ServerAuthMissingCredentialError } from "../../auth/EnvironmentAuth.ts";
import { PlaybookService } from "../playbook-definitions/Service.ts";
import { playbookHttpLayer } from "./Http.ts";
import { runPlaybookMigrations } from "./Migrations.ts";
import { PlaybookError } from "./Store.ts";

it("requires authentication and operate scope, validates gate input, and records the authenticated actor", async () => {
  let mode: "missing" | "read" | "operate" = "missing";
  let actor = "";
  let eventType = "";
  let mutations = 0;
  const routes = playbookHttpLayer.pipe(
    Layer.provide(
      Layer.mock(PlaybookService)({
        definitions: Effect.succeed([]),
        mutate: (_id, _commandId, _revision, event) => {
          mutations++;
          eventType = event.type;
          if (event.type === "decision") actor = event.decision.actor;
          return Effect.fail(
            new PlaybookError({ code: "conflict", detail: "Gate revision changed" }),
          );
        },
      }),
    ),
    Layer.provideMerge(
      Layer.mock(EnvironmentAuth)({
        authenticateHttpRequest: () =>
          mode === "missing"
            ? Effect.fail(new ServerAuthMissingCredentialError({}))
            : Effect.succeed({
                sessionId: AuthSessionId.make("playbook-test"),
                subject: "authenticated-human",
                method: "bearer-access-token",
                scopes:
                  mode === "read"
                    ? [AuthOrchestrationReadScope]
                    : [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
              }),
      }),
    ),
    Layer.provide(HttpServer.layerServices),
    Layer.provide(NodeSqliteClient.layerMemory()),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  const request = (body: unknown, action = "decide") =>
    new Request(`http://environment.test/api/j5/playbooks/test/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const body = {
    commandId: "decision",
    expectedRevision: 3,
    gateRevision: 3,
    artifactHash: "reviewed",
    decision: "approve",
    feedback: "",
    actor: "forged",
  };
  try {
    assert.equal((await handler(request(body))).status, 401);
    mode = "read";
    assert.equal((await handler(request(body))).status, 403);
    assert.equal(mutations, 0);
    mode = "operate";
    assert.equal((await handler(request({ decision: "approve" }))).status, 400);
    assert.equal((await handler(request(body))).status, 409);
    assert.equal(actor, "authenticated-human");
    assert.equal(mutations, 1);
    assert.equal(
      (await handler(request({ commandId: "resume", expectedRevision: 4 }, "resume"))).status,
      409,
    );
    assert.equal(eventType, "resume");
    assert.equal(mutations, 2);
  } finally {
    await dispose();
  }
});

it("protects observability reads and rejects malformed pagination before reading", async () => {
  let mode: "missing" | "unscoped" | "read" = "missing";
  const database = NodeSqliteClient.layerMemory();
  const routes = playbookHttpLayer.pipe(
    Layer.provide(
      Layer.mock(PlaybookService)({
        definitions: Effect.succeed([]),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(EnvironmentAuth)({
        authenticateHttpRequest: () =>
          mode === "missing"
            ? Effect.fail(new ServerAuthMissingCredentialError({}))
            : Effect.succeed({
                sessionId: AuthSessionId.make("playbook-read-test"),
                subject: "reader",
                method: "bearer-access-token",
                scopes: mode === "read" ? [AuthOrchestrationReadScope] : [],
              }),
      }),
    ),
    Layer.provideMerge(Layer.effectDiscard(runPlaybookMigrations())),
    Layer.provide(HttpServer.layerServices),
    Layer.provide(database),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  try {
    const timeline = (suffix = "") =>
      new Request(`http://environment.test/api/j5/playbooks/missing/timeline${suffix}`);
    assert.equal((await handler(timeline())).status, 401);
    mode = "unscoped";
    assert.equal((await handler(timeline())).status, 403);
    mode = "read";
    assert.equal(
      (await handler(new Request("http://environment.test/api/j5/workflows"))).status,
      404,
    );
    assert.equal((await handler(timeline("?before=1.5"))).status, 400);
    assert.equal((await handler(timeline("?before=-1"))).status, 400);
    assert.equal((await handler(timeline("?before=Infinity"))).status, 400);
    assert.equal((await handler(timeline("?limit=0"))).status, 400);
    assert.equal((await handler(timeline("?limit=101"))).status, 404);
    assert.equal(
      (await handler(new Request("http://environment.test/api/j5/playbooks/board?offset="))).status,
      400,
    );
    assert.equal(
      (await handler(new Request("http://environment.test/api/j5/playbooks/board?status=nope")))
        .status,
      400,
    );
  } finally {
    await dispose();
  }
});
