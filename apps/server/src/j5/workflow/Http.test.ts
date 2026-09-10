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
import { WorkflowService } from "../workflow-definitions/Service.ts";
import { workflowHttpLayer } from "./Http.ts";
import { WorkflowError } from "./Store.ts";

it("requires authentication and operate scope, validates gate input, and records the authenticated actor", async () => {
  let mode: "missing" | "read" | "operate" = "missing";
  let actor = "";
  let mutations = 0;
  const routes = workflowHttpLayer.pipe(
    Layer.provide(
      Layer.mock(WorkflowService)({
        definitions: [],
        mutate: (_id, _commandId, _revision, event) => {
          mutations++;
          if (event.type === "decision") actor = event.decision.actor;
          return Effect.fail(
            new WorkflowError({ code: "conflict", detail: "Gate revision changed" }),
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
                sessionId: AuthSessionId.make("workflow-test"),
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
  const request = (body: unknown) =>
    new Request("http://environment.test/api/j5/workflows/test/decide", {
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
  } finally {
    await dispose();
  }
});
