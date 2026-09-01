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
import { ExchangeId, LedgerMessageId, ParticipantId } from "./contracts.ts";

it("returns the resolved person above an empty inbox and preserves explicit selection", async () => {
  const localPersonId = ParticipantId.make("human:local-operator");
  const explicitPersonId = ParticipantId.make("human:second-person");
  const missingPersonId = ParticipantId.make("human:missing-person");
  const requested: Array<string | undefined> = [];
  const requestedStatuses: Array<string | undefined> = [];
  const answerCommandIds: Array<string> = [];
  const inbox = Layer.mock(A2AHumanInbox)({
    resolvePersonId: (personId) => {
      requested.push(personId);
      if (personId === missingPersonId) {
        return Effect.fail(new A2AParticipantNotFoundError({ participantId: personId }));
      }
      return Effect.succeed(personId ?? localPersonId);
    },
    list: (_personId, status) => {
      requestedStatuses.push(status);
      return Effect.succeed([]);
    },
    answer: (input) => {
      answerCommandIds.push(input.commandId);
      return Effect.succeed({
        messageId: LedgerMessageId.make(`message:test:${input.exchangeId}`),
        exchangeId: input.exchangeId,
        exchangeState: "closed",
        joinedExistingExchange: false,
        durableAtSeq: 1,
      });
    },
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
    Layer.provide(Layer.mock(A2ADeliveryWorker)({ notify: Effect.void })),
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
    const answered = await handler(
      new Request("http://environment.test/api/j5/a2a/inbox?status=answered"),
    );
    const invalidStatus = await handler(
      new Request("http://environment.test/api/j5/a2a/inbox?status=unknown"),
    );

    const discoveredBody = await discovered.json();
    assert.equal(discovered.status, 200, JSON.stringify(discoveredBody));
    assert.deepStrictEqual(discoveredBody, { personId: localPersonId, items: [] });
    assert.equal(explicit.status, 200);
    assert.deepStrictEqual(await explicit.json(), { personId: explicitPersonId, items: [] });
    assert.equal(missing.status, 404);
    assert.equal(answered.status, 200);
    assert.equal(invalidStatus.status, 400);
    assert.deepStrictEqual(requested, [undefined, explicitPersonId, missingPersonId, undefined]);
    assert.deepStrictEqual(requestedStatuses, ["open", "open", "answered"]);

    const firstExchangeId = ExchangeId.make("exchange:same-client:first");
    const secondExchangeId = ExchangeId.make("exchange:same-client:second");
    const clientRequestId = "reused-client-request";
    const answer = (exchangeId: ExchangeId) =>
      handler(
        new Request("http://environment.test/api/j5/a2a/inbox/answer", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            personId: localPersonId,
            exchangeId,
            message: `Answer for ${exchangeId}`,
            clientRequestId,
          }),
        }),
      );
    assert.equal((await answer(firstExchangeId)).status, 200);
    assert.equal((await answer(secondExchangeId)).status, 200);
    assert.deepStrictEqual(answerCommandIds, [
      `command:j5:a2a:human:${encodeURIComponent(localPersonId)}:${encodeURIComponent(firstExchangeId)}:${encodeURIComponent(clientRequestId)}`,
      `command:j5:a2a:human:${encodeURIComponent(localPersonId)}:${encodeURIComponent(secondExchangeId)}:${encodeURIComponent(clientRequestId)}`,
    ]);
  } finally {
    await dispose();
  }
});
