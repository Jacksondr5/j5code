import { assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { HumanInboxHttpError, listHumanInboxEffect } from "./humanInboxClient";

vi.stubGlobal("window", {
  location: new URL("http://environment.test/"),
});

it.effect(
  "discovers the local operator from an empty default inbox and keeps explicit selection",
  () =>
    Effect.gen(function* () {
      const urls: Array<URL> = [];
      const localPersonId = "human:local-operator";
      const explicitPersonId = "human:second-person";
      const client = HttpClient.make((request) => {
        const url = new URL(request.url);
        urls.push(url);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              personId: url.searchParams.get("personId") ?? localPersonId,
              items: [],
            }),
          ),
        );
      });

      const discovered = yield* listHumanInboxEffect().pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      const explicit = yield* listHumanInboxEffect(explicitPersonId).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );

      assert.deepStrictEqual(discovered, { personId: localPersonId, items: [] });
      assert.deepStrictEqual(explicit, { personId: explicitPersonId, items: [] });
      assert.equal(urls[0]?.searchParams.has("personId"), false);
      assert.equal(urls[1]?.searchParams.get("personId"), explicitPersonId);
      assert.equal(urls[0]?.searchParams.get("status"), "open");
      assert.equal(urls[1]?.searchParams.get("status"), "open");
    }),
);

it.effect("surfaces the server's human inbox error message", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(
            { error: "A2AExchangeAlreadyAnsweredError", message: "This exchange was answered." },
            { status: 409 },
          ),
        ),
      ),
    );

    const error = yield* Effect.flip(
      listHumanInboxEffect().pipe(Effect.provideService(HttpClient.HttpClient, client)),
    );

    assert.instanceOf(error, HumanInboxHttpError);
    assert.equal(error.status, 409);
    assert.equal(error.message, "This exchange was answered.");
  }),
);
