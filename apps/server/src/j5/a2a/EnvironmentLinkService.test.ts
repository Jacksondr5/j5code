import { assert, it } from "@effect/vitest";
import { EnvironmentId, type PeerLink, PeerLinkError } from "@t3tools/contracts";
import { J5_LINK_SESSION_API_PATH } from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as PeerLinks from "../../peer/PeerLinks.ts";
import { EnvironmentLinkService, layerOver, LINE_WAIT } from "./EnvironmentLinkService.ts";
import { LineClosedError } from "./line/LineMux.ts";
import { LineRegistry, type LineUp } from "./line/LineRegistry.ts";

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
  /** The addresses upstream's link was asked to link at, in order. */
  readonly linkedAt?: Array<string>;
  /** The lines up here, each as it comes up, and when a link started to wait for one. */
  readonly lines?: {
    readonly up: Set<string>;
    readonly ups: PubSub.PubSub<LineUp>;
    readonly waiting: Deferred.Deferred<void>;
  };
}) =>
  layerOver.pipe(
    Layer.provide(
      Layer.mock(LineRegistry)({
        connect: () => new LineClosedError("Not used here."),
        currentLineId: () => null,
        isUp: (host) => input.lines?.up.has(host) === true,
        subscribeUps:
          input.lines === undefined
            ? Effect.succeed(Stream.never)
            : PubSub.subscribe(input.lines.ups).pipe(
                Effect.map(Stream.fromSubscription),
                Effect.tap(() => Deferred.succeed(input.lines!.waiting, undefined)),
              ),
      }),
    ),
    Layer.provide(
      Layer.mock(PeerLinks.PeerLinks)({
        link: (link) =>
          Effect.sync(() => {
            input.linkedAt?.push(link.url);
            return workLink;
          }),
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

it.effect("waits for a poller's line before linking through it, and no longer than the bound", () =>
  Effect.gen(function* () {
    const lineUrl = "http://127.77.0.1:1";
    const linkThroughLine = Effect.fn("test.linkThroughLine")(function* (linkedAt: Array<string>) {
      const lines = {
        up: new Set<string>(),
        ups: yield* PubSub.unbounded<LineUp>(),
        waiting: yield* Deferred.make<void>(),
      };
      const context = yield* Layer.build(
        makeLayer({ resolve: "linked", answer: 204, seen: [], unlinked: [], linkedAt, lines }),
      );
      const linking = yield* Effect.forkChild(
        Context.get(context, PeerLinks.PeerLinks).link({
          url: lineUrl,
          pairingCode: "code",
          access: "approval-required",
        }),
      );
      yield* Deferred.await(lines.waiting);
      return { lines, linking };
    });

    const arrives: Array<string> = [];
    const arriving = yield* linkThroughLine(arrives);
    assert.deepStrictEqual(arrives, [], "nothing is linked while the line is down");
    // Another server's line coming up is not this one's.
    yield* PubSub.publish(arriving.lines.ups, { environmentId: "environment-desk", lineId: "a" });
    arriving.lines.up.add("127.77.0.1");
    yield* PubSub.publish(arriving.lines.ups, { environmentId: work, lineId: "b" });
    yield* Fiber.join(arriving.linking);
    assert.deepStrictEqual(arrives, [lineUrl]);

    const never: Array<string> = [];
    const absent = yield* linkThroughLine(never);
    yield* TestClock.adjust(LINE_WAIT);
    yield* Fiber.join(absent.linking);
    assert.deepStrictEqual(never, [lineUrl], "past the bound the link goes on, to fail as usual");
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
