import { assert, expect, it, vi } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  listThreadHomesEffect,
  mergeThreadHomeEntries,
  shouldRequestThreadHome,
  type ThreadHome,
  ThreadHomesHttpError,
} from "./ThreadHomesClient";

vi.stubGlobal("window", { location: new URL("http://environment.test/") });

it.effect("reads B6's opaque thread-home batch without project metadata", () =>
  Effect.gen(function* () {
    const requests: Array<{ readonly method: string; readonly url: URL }> = [];
    const client = HttpClient.make((request) => {
      requests.push({ method: request.method, url: new URL(request.url) });
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            entries: [
              {
                threadId: "thread:alpha",
                home: { kind: "known", squadron: { id: "squadron:alpha", name: "Alpha" } },
              },
              { threadId: "thread:native", home: { kind: "unknown" } },
            ],
          }),
        ),
      );
    });

    const entries = yield* listThreadHomesEffect([
      ThreadId.make("thread:alpha"),
      ThreadId.make("thread:native"),
    ]).pipe(Effect.provideService(HttpClient.HttpClient, client));

    assert.deepStrictEqual(requests, [
      { method: "POST", url: new URL("http://environment.test/api/j5/a2a/thread-homes") },
    ]);
    assert.deepStrictEqual(entries, [
      {
        threadId: ThreadId.make("thread:alpha"),
        home: { kind: "known", squadron: { id: "squadron:alpha", name: "Alpha" } },
      },
      { threadId: ThreadId.make("thread:native"), home: { kind: "unknown" } },
    ]);
  }),
);

it.effect("preserves an authenticated thread-home read failure", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ message: "Sign in again." }, { status: 401 }),
        ),
      ),
    );
    const error = yield* Effect.flip(
      listThreadHomesEffect([ThreadId.make("thread:alpha")]).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      ),
    );
    assert.instanceOf(error, ThreadHomesHttpError);
    assert.equal(error.message, "Sign in again.");
  }),
);

it("replaces a transient unknown with the durable Registrar home after interactive launch", () => {
  const homes = new Map<string, ThreadHome>();
  mergeThreadHomeEntries(homes, [
    { threadId: ThreadId.make("thread:alpha"), home: { kind: "unknown" } },
  ]);

  expect(shouldRequestThreadHome(homes.get("thread:alpha"), false)).toBe(false);
  expect(shouldRequestThreadHome(homes.get("thread:alpha"), true)).toBe(true);

  mergeThreadHomeEntries(homes, [
    {
      threadId: ThreadId.make("thread:alpha"),
      home: { kind: "known", squadron: { id: "squadron:alpha", name: "Alpha" } },
    },
  ]);
  expect(homes.get("thread:alpha")).toEqual({
    kind: "known",
    squadron: { id: "squadron:alpha", name: "Alpha" },
  });
});
