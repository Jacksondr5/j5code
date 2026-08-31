import { assert, expect, it, vi } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  listThreadHomesEffect,
  mergeThreadHomeEntries,
  replaceThreadHomeEntries,
  shouldForceThreadHomesForScope,
  shouldRequestThreadHome,
  type ThreadHome,
  ThreadHomesHttpError,
} from "./ThreadHomesClient";
import { filterThreadsForSquadronScope } from "./SquadronScope.logic";

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

it("replaces a missing or stale home in the exact cache map read by Squadron filtering", () => {
  const threads = [{ id: "thread:alpha" }, { id: "thread:native" }];
  const alphaScope = { id: "squadron:alpha", name: "Alpha", projectIds: ["project:shared"] };
  const homes = new Map<string, ThreadHome>();
  expect(filterThreadsForSquadronScope(threads, alphaScope, homes)).toEqual([]);
  mergeThreadHomeEntries(homes, [
    { threadId: ThreadId.make("thread:alpha"), home: { kind: "unknown" } },
    { threadId: ThreadId.make("thread:native"), home: { kind: "unknown" } },
  ]);

  expect(shouldRequestThreadHome(homes.get("thread:alpha"), false)).toBe(false);
  expect(shouldForceThreadHomesForScope(null)).toBe(false);
  expect(shouldForceThreadHomesForScope(alphaScope.id)).toBe(true);
  // A failed or not-yet-completed prior read is likewise retried under an
  // explicit scope; no missing home is inferred from the current project.
  expect(shouldRequestThreadHome(undefined, shouldForceThreadHomesForScope(alphaScope.id))).toBe(
    true,
  );
  expect(
    shouldRequestThreadHome(
      homes.get("thread:alpha"),
      shouldForceThreadHomesForScope(alphaScope.id),
    ),
  ).toBe(true);
  expect(filterThreadsForSquadronScope(threads, alphaScope, homes)).toEqual([]);

  // The receipt must overwrite the same map instance consumed by the Sidebar
  // predicate, not a separate HMR-era module cache.
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
  expect(filterThreadsForSquadronScope(threads, alphaScope, homes)).toEqual([threads[0]]);
});

it("publishes a new rendered snapshot when a receipt replaces an initial unknown home", () => {
  const threads = [{ id: "thread:alpha" }];
  const alphaScope = { id: "squadron:alpha", name: "Alpha", projectIds: ["project:shared"] };
  const initialSnapshot = new Map<string, ThreadHome>([["thread:alpha", { kind: "unknown" }]]);

  expect(filterThreadsForSquadronScope(threads, alphaScope, initialSnapshot)).toEqual([]);

  const receiptSnapshot = replaceThreadHomeEntries(initialSnapshot, [
    {
      threadId: ThreadId.make("thread:alpha"),
      home: { kind: "known", squadron: { id: "squadron:alpha", name: "Alpha" } },
    },
  ]);

  // React observes this reference as its external-store snapshot. A new
  // reference is therefore as important as the known-home contents.
  expect(receiptSnapshot).not.toBe(initialSnapshot);
  expect(initialSnapshot.get("thread:alpha")).toEqual({ kind: "unknown" });
  expect(filterThreadsForSquadronScope(threads, alphaScope, receiptSnapshot)).toEqual(threads);
});
