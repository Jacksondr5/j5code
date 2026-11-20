import { assert, it } from "@effect/vitest";
import { EnvironmentId, type PeerLink, PeerLinkError } from "@t3tools/contracts";
import { J5_LINK_SESSION_API_PATH } from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as PeerLinks from "../../peer/PeerLinks.ts";
import { EnvironmentLinkService, layerOver } from "./EnvironmentLinkService.ts";

const home = EnvironmentId.make("environment-home");
const work = EnvironmentId.make("environment-work");
const workUrl = "https://work.example";

const workLink: PeerLink = {
  environmentId: work,
  label: "Work",
  urls: [workUrl],
  access: "approval-required",
  linkedAt: DateTime.makeUnsafe("2026-11-01T00:00:00.000Z"),
  expiresAt: DateTime.makeUnsafe("2026-12-01T00:00:00.000Z"),
  lastReachedAt: null,
  lastError: null,
};

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

/** Work as the link reaches it: how its link exists here, and what its session route answers. */
const makeLayer = (input: {
  readonly resolve: "linked" | PeerLinkError;
  /** The session route's status, or null when Work does not answer. */
  readonly answer: number | null;
  readonly seen: Array<Seen>;
  readonly unlinked: Array<string>;
}) =>
  layerOver.pipe(
    Layer.provide(
      Layer.mock(PeerLinks.PeerLinks)({
        link: () => Effect.succeed(workLink),
        resolve: () =>
          input.resolve === "linked"
            ? Effect.succeed({ link: workLink, url: workUrl, token: "work-token" })
            : Effect.fail(input.resolve),
        unlink: (environmentId) =>
          Effect.sync(() => {
            input.unlinked.push(environmentId);
            return true;
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          input.seen.push({
            method: request.method,
            url: request.url,
            authorization: request.headers.authorization,
            body:
              request.body._tag === "Uint8Array" ? JSON.parse(request.body.body.toString()) : null,
          });
          return input.answer === null
            ? Effect.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({
                    request,
                    description: "ECONNREFUSED",
                  }),
                }),
              )
            : Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(null, { status: input.answer })),
              );
        }),
      ),
    ),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({ getEnvironmentId: Effect.succeed(home) }),
    ),
  );

const sessionUrl = `${workUrl}${J5_LINK_SESSION_API_PATH}`;

it.effect("tells the other server which server holds a new link, whatever it answers", () =>
  Effect.gen(function* () {
    for (const answer of [204, 404, null]) {
      const seen: Array<Seen> = [];
      const linked = yield* PeerLinks.PeerLinks.pipe(
        Effect.flatMap((links) =>
          links.link({ url: workUrl, pairingCode: "code", access: "approval-required" }),
        ),
        Effect.provide(makeLayer({ resolve: "linked", answer, seen, unlinked: [] })),
      );
      assert.equal(linked.environmentId, work, `the link stands when Work answers ${answer}`);
      assert.deepStrictEqual(seen, [
        {
          method: "PUT",
          url: sessionUrl,
          authorization: "Bearer work-token",
          body: { environmentId: home },
        },
      ]);
    }
  }),
);

it.effect("forgets a link after asking the other server to end its session", () =>
  Effect.gen(function* () {
    const cases = [
      { name: "ended there", resolve: "linked", answer: 204, asked: true, revoked: true },
      { name: "an older server", resolve: "linked", answer: 404, asked: true, revoked: false },
      { name: "no answer", resolve: "linked", answer: null, asked: true, revoked: false },
      {
        name: "unreachable",
        resolve: new PeerLinkError({ reason: "unreachable", message: "Work did not answer." }),
        answer: 204,
        asked: false,
        revoked: false,
      },
      {
        name: "expired, so its session is too",
        resolve: new PeerLinkError({ reason: "expired", message: "The link to Work expired." }),
        answer: 204,
        asked: false,
        revoked: true,
      },
    ] as const;
    for (const row of cases) {
      const seen: Array<Seen> = [];
      const unlinked: Array<string> = [];
      const outcome = yield* EnvironmentLinkService.pipe(
        Effect.flatMap((links) => links.forget({ environmentId: work })),
        Effect.provide(makeLayer({ resolve: row.resolve, answer: row.answer, seen, unlinked })),
      );
      assert.deepStrictEqual(
        seen.map((request) => `${request.method} ${request.url} ${request.authorization}`),
        row.asked ? [`DELETE ${sessionUrl} Bearer work-token`] : [],
        row.name,
      );
      assert.deepStrictEqual(
        unlinked,
        [work],
        `${row.name}: the link is forgotten here either way`,
      );
      assert.equal(outcome.removed, true, row.name);
      assert.equal(outcome.sessionRevoked, row.revoked, row.name);
      assert.equal(outcome.detail === null, row.revoked, `${row.name}: a session left says why`);
    }
  }),
);
