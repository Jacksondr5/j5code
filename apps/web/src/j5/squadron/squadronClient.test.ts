import { assert, it, vi } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { createSquadronEffect, listSquadronsEffect, SquadronHttpError } from "./squadronClient";

vi.stubGlobal("window", { location: new URL("http://environment.test/") });

it.effect("reads the authenticated Squadron list from the J5 route", () =>
  Effect.gen(function* () {
    const urls: URL[] = [];
    const client = HttpClient.make((request) => {
      urls.push(new URL(request.url));
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            squadrons: [
              {
                squadron: {
                  id: "squadron:alpha",
                  name: "Alpha",
                  createdAt: "2026-08-29T00:00:00Z",
                },
                projectIds: ["project:alpha"],
              },
            ],
          }),
        ),
      );
    });

    const squadrons = yield* listSquadronsEffect().pipe(
      Effect.provideService(HttpClient.HttpClient, client),
    );

    assert.equal(urls[0]?.pathname, "/api/j5/squadrons");
    assert.equal(squadrons[0]?.squadron.name, "Alpha");
  }),
);

it.effect("creates a Squadron only from the explicitly selected existing folder", () =>
  Effect.gen(function* () {
    const requests: Array<{ readonly method: string; readonly url: URL }> = [];
    const client = HttpClient.make((request) => {
      requests.push({ method: request.method, url: new URL(request.url) });
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            squadron: {
              squadron: {
                id: "squadron:created",
                name: "Created",
                createdAt: "2026-08-29T00:00:00Z",
              },
              projectIds: ["project:selected"],
            },
          }),
        ),
      );
    });

    const created = yield* createSquadronEffect({
      name: "Created",
      projectId: ProjectId.make("project:selected"),
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));

    assert.deepStrictEqual(requests, [
      { method: "POST", url: new URL("http://environment.test/api/j5/squadrons") },
    ]);
    assert.deepStrictEqual(created.projectIds, [ProjectId.make("project:selected")]);
  }),
);

it.effect("preserves the authenticated route error for the first-run gate", () =>
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
      listSquadronsEffect().pipe(Effect.provideService(HttpClient.HttpClient, client)),
    );

    assert.instanceOf(error, SquadronHttpError);
    assert.equal(error.message, "Sign in again.");
  }),
);
