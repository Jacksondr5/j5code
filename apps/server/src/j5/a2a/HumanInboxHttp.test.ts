import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { A2ADeliveryWorker } from "./DeliveryWorker.ts";
import { humanInboxHttpRouteLayer } from "./HumanInboxHttp.ts";
import { A2AHumanInbox } from "./HumanInboxService.ts";
import { A2AParticipantNotFoundError } from "./SendService.ts";
import { ParticipantId } from "./contracts.ts";

it("returns the resolved person above an empty inbox and preserves explicit selection", async () => {
  const localPersonId = ParticipantId.make("human:local-operator");
  const explicitPersonId = ParticipantId.make("human:second-person");
  const missingPersonId = ParticipantId.make("human:missing-person");
  const requested: Array<string | undefined> = [];
  const inbox = Layer.mock(A2AHumanInbox)({
    resolvePersonId: (personId) => {
      requested.push(personId);
      if (personId === missingPersonId) {
        return Effect.fail(new A2AParticipantNotFoundError({ participantId: personId }));
      }
      return Effect.succeed(personId ?? localPersonId);
    },
    list: () => Effect.succeed([]),
  });
  const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: () =>
      Effect.succeed({
        sessionId: AuthSessionId.make("auth-session:human-inbox"),
        subject: "human-inbox-test",
        method: "bearer-access-token",
        scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      }),
  });
  const routes = humanInboxHttpRouteLayer.pipe(
    Layer.provide(inbox),
    Layer.provide(Layer.mock(A2ADeliveryWorker)({})),
    Layer.provideMerge(auth),
    Layer.provide(HttpServer.layerServices),
  );
  const { dispose, handler } = HttpRouter.toWebHandler(routes, { disableLogger: true });

  try {
    const discovered = await handler(new Request("http://environment.test/api/j5/a2a/inbox"));
    const explicit = await handler(
      new Request(
        `http://environment.test/api/j5/a2a/inbox?personId=${encodeURIComponent(explicitPersonId)}`,
      ),
    );
    const missing = await handler(
      new Request(
        `http://environment.test/api/j5/a2a/inbox?personId=${encodeURIComponent(missingPersonId)}`,
      ),
    );

    const discoveredBody = await discovered.json();
    assert.equal(discovered.status, 200, JSON.stringify(discoveredBody));
    assert.deepStrictEqual(discoveredBody, { personId: localPersonId, items: [] });
    assert.equal(explicit.status, 200);
    assert.deepStrictEqual(await explicit.json(), { personId: explicitPersonId, items: [] });
    assert.equal(missing.status, 404);
    assert.deepStrictEqual(requested, [undefined, explicitPersonId, missingPersonId]);
  } finally {
    await dispose();
  }
});
