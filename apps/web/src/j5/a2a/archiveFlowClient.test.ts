import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { readPreArchiveFactsEffect } from "./archiveFlowClient";

it.effect("reads consequential archive facts from the thread's non-primary environment", () =>
  Effect.gen(function* () {
    const remoteThreadRef = scopeThreadRef(
      "environment:remote" as never,
      ThreadId.make("thread:remote-archive"),
    );
    const urls: URL[] = [];
    const client = HttpClient.make((request) => {
      urls.push(new URL(request.url));
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            state: "registered",
            threadId: remoteThreadRef.threadId,
            squadronId: "squadron:remote",
            participantId: "agent:remote",
            retired: false,
            openExchanges: [
              {
                squadronId: "squadron:remote",
                exchangeId: "exchange:remote-waiter",
                direction: "inbound",
                replyObligation: "participant-owes-reply",
                counterpartyId: "agent:waiter",
                intent: "Wait for the remote archive",
                urgency: "blocking",
                openedAt: "2026-08-31T10:00:00.000Z",
              },
            ],
            placementSubtree: { state: "none" },
          }),
        ),
      );
    });

    const facts = yield* readPreArchiveFactsEffect({
      threadRef: remoteThreadRef,
      prepared: {
        httpBaseUrl: "https://remote-environment.test:3773",
        httpAuthorization: null,
      } as PreparedConnection,
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));

    assert.equal(
      urls[0]?.toString(),
      "https://remote-environment.test:3773/api/j5/a2a/pre-archive-facts",
    );
    assert.equal(facts.state, "registered");
    assert.equal(facts.openExchanges.length, 1);
  }),
);
