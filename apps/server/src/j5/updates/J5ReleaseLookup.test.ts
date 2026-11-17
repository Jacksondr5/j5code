import { expect, it } from "@effect/vitest";
import { ServerNpmReleaseError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";

import * as J5ReleaseLookup from "./J5ReleaseLookup.ts";

const NIGHTLY = "0.0.52-nightly.20261111.17";
const STABLE = "0.0.52";
const index = [
  { tag_name: `v0.0.53-nightly.20261120.18`, draft: true },
  { tag_name: `v${NIGHTLY}` },
  { tag_name: `v${STABLE}` },
];
const metadata = { databaseMigration: 79, j5DatabaseMigrations: { j5_a2a_migrations: 57 } };

/** A fake GitHub: `files` maps a URL's path suffix to its body, a status, or "stall" for headers
 * with a body that never ends; anything else is a 404. */
const makeService = (files: Record<string, string | number>) => {
  const urls: string[] = [];
  const http = HttpClient.make((request) => {
    urls.push(request.url);
    const path = new URL(request.url).pathname + new URL(request.url).search;
    const match = Object.entries(files).find(([suffix]) => path.endsWith(suffix))?.[1];
    const response =
      match === "stall"
        ? new Response(new ReadableStream())
        : typeof match === "string"
          ? new Response(match)
          : new Response("", { status: typeof match === "number" ? match : 404 });
    return Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });
  return J5ReleaseLookup.make().pipe(
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.map((service) => ({ service, urls })),
  );
};

it.effect.each([
  { spec: "latest", version: STABLE },
  { spec: "nightly", version: NIGHTLY },
  { spec: STABLE, version: STABLE },
])("finds $spec on J5's releases with its migrations", ({ spec, version }) =>
  Effect.gen(function* () {
    const { service } = yield* makeService({
      "/releases?per_page=100&page=1": JSON.stringify(index),
      [`/v${version}/SHA256SUMS`]: "sums",
      [`/v${version}/release-metadata.json`]: JSON.stringify(metadata),
    });
    expect(yield* service.get({ spec })).toEqual({ version, ...metadata });
  }),
);

it.effect("pages past nightlies to the newest stable release", () =>
  Effect.gen(function* () {
    const nightlies = Array.from({ length: 100 }, (_, n) => ({
      tag_name: `v0.0.52-nightly.20261111.${n}`,
    }));
    const { service } = yield* makeService({
      "/releases?per_page=100&page=1": JSON.stringify(nightlies),
      "/releases?per_page=100&page=2": JSON.stringify([{ tag_name: `v${STABLE}` }]),
    });
    expect(yield* service.get({ spec: "latest" })).toEqual({ version: STABLE });
  }),
);

it.effect("gives up on a response whose body stalls", () =>
  Effect.gen(function* () {
    const { service } = yield* makeService({ "/releases?per_page=100&page=1": "stall" });
    const stalled = yield* service.get({ spec: "latest" }).pipe(Effect.result, Effect.forkChild);
    yield* TestClock.adjust("15 seconds");
    const found = yield* Fiber.join(stalled);
    expect(Result.isFailure(found) && found.failure).toBeInstanceOf(ServerNpmReleaseError);
  }),
);

it.effect("reports a release without metadata as predating database checks", () =>
  Effect.gen(function* () {
    const { service } = yield* makeService({
      "/releases?per_page=100&page=1": JSON.stringify(index),
    });
    expect(yield* service.get({ spec: "latest" })).toEqual({ version: STABLE });
  }),
);

it.effect("treats a version with no published release as unpublished", () =>
  Effect.gen(function* () {
    const { service } = yield* makeService({});
    expect(yield* service.get({ spec: "9.9.9" })).toBeNull();
  }),
);

it.effect.each([
  { name: "a refused index", files: { "/releases?per_page=100&page=1": 403 } },
  { name: "an invalid index", files: { "/releases?per_page=100&page=1": "{}" } },
  {
    name: "invalid metadata",
    files: {
      "/releases?per_page=100&page=1": JSON.stringify(index),
      [`/v${STABLE}/release-metadata.json`]: '{"databaseMigration":"79"}',
    },
  },
])("fails the lookup on $name rather than reporting no release", ({ files }) =>
  Effect.gen(function* () {
    const { service } = yield* makeService(files);
    const found = yield* service.get({ spec: "latest" }).pipe(Effect.result);
    expect(Result.isFailure(found) && found.failure).toBeInstanceOf(ServerNpmReleaseError);
  }),
);
