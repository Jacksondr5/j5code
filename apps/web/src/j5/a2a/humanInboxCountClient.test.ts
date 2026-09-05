import { assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { readOpenInboxCountEffect } from "./humanInboxCountClient";

vi.stubGlobal("window", {
  location: new URL("http://environment.test/"),
});

it.effect("reads the B6 open-count slot without inventing another route", () =>
  Effect.gen(function* () {
    const requests: Array<{ readonly method: string; readonly url: string }> = [];
    const client = HttpClient.make((request) => {
      requests.push({ method: request.method, url: request.url });
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ personId: "human:local-operator", count: 3 }),
        ),
      );
    });

    const result = yield* readOpenInboxCountEffect().pipe(
      Effect.provideService(HttpClient.HttpClient, client),
    );

    assert.deepStrictEqual(result, { personId: "human:local-operator", count: 3 });
    assert.deepStrictEqual(requests, [
      {
        method: "POST",
        url: "http://environment.test/api/j5/a2a/client-reads/open-count",
      },
    ]);
  }),
);

it.effect("rejects an impossible negative count instead of displaying a fake value", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ personId: "human:local-operator", count: -1 }),
        ),
      ),
    );

    yield* Effect.flip(
      readOpenInboxCountEffect().pipe(Effect.provideService(HttpClient.HttpClient, client)),
    );
  }),
);
