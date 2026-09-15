// @effect-diagnostics nodeBuiltinImport:off - the CLI is exercised against a stub HTTP server.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";
import { afterEach, beforeEach, vi } from "vite-plus/test";

import { cli } from "../../bin.ts";
import { A2A_EXIT_CODES } from "./a2a.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);
const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(Effect.provide(CliRuntimeLayer));

interface StubRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

interface StubServer {
  readonly origin: string;
  readonly requests: Array<StubRequest>;
  readonly close: () => Promise<void>;
}

type StubReply = { readonly status: number; readonly body: unknown };

const startStub = (respond: (request: StubRequest) => StubReply) =>
  new Promise<StubServer>((resolve) => {
    const requests: Array<StubRequest> = [];
    const server = NodeHttp.createServer((request, response) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => (raw += chunk));
      request.on("end", () => {
        const stubRequest: StubRequest = {
          method: request.method ?? "GET",
          url: request.url ?? "/",
          authorization: request.headers.authorization,
          body: raw.length === 0 ? null : (JSON.parse(raw) as unknown),
        };
        requests.push(stubRequest);
        const reply = respond(stubRequest);
        response.writeHead(reply.status, { "content-type": "application/json" });
        response.end(JSON.stringify(reply.body));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as NodeNet.AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${String(port)}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });

/** One stub per test body; the server is closed even when an assertion fails. */
const withStub = <A, E, R>(
  respond: (request: StubRequest) => StubReply,
  use: (stub: StubServer) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => startStub(respond)),
    use,
    (stub) => Effect.promise(() => stub.close()),
  );

let logged: Array<string> = [];
let errored: Array<string> = [];

beforeEach(() => {
  logged = [];
  errored = [];
  vi.spyOn(console, "log").mockImplementation((...args: Array<unknown>) => {
    logged.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: Array<unknown>) => {
    errored.push(args.map(String).join(" "));
  });
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const lastJson = () => JSON.parse(logged.at(-1) ?? "null") as Record<string, unknown>;

const sendArgs = (origin: string, extra: ReadonlyArray<string> = ["--token", "t"]) => [
  "a2a",
  "send",
  "--origin",
  origin,
  ...extra,
  "--to",
  "obs-sentinel",
  "--message",
  "canary 42",
  "--client-request-id",
  "canary-42",
  "--json",
];

const receipt = {
  sender: "machine:watchdog",
  receiver: "agent:j5:a2a:thread:sentinel",
  result: {
    messageId: "message:j5:a2a:one",
    exchangeId: null,
    exchangeState: "none",
    joinedExistingExchange: false,
    durableAtSeq: 7,
  },
};

it.live(
  "sends with the bearer token and prints the receipt; a retry simply sends the same id",
  () =>
    withStub(
      () => ({ status: 200, body: receipt }),
      (stub) =>
        Effect.gen(function* () {
          yield* runCli(sendArgs(stub.origin, ["--token", "secret-token"]));
          yield* runCli(sendArgs(stub.origin, ["--token", "secret-token"]));
          assert.equal(process.exitCode, undefined);
          assert.equal(stub.requests.length, 2);
          assert.equal(stub.requests[0]!.method, "POST");
          assert.equal(stub.requests[0]!.url, "/api/j5/a2a/send");
          assert.equal(stub.requests[0]!.authorization, "Bearer secret-token");
          assert.deepStrictEqual(stub.requests[0]!.body, {
            to: "obs-sentinel",
            message: "canary 42",
            clientRequestId: "canary-42",
          });
          const output = lastJson();
          assert.equal(output.ok, true);
          assert.deepStrictEqual(output.result, receipt.result);
        }),
    ),
);

it.live("maps server refusals to the documented exit codes", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<{ readonly reply: StubReply; readonly exitCode: number }> = [
      {
        reply: { status: 401, body: { error: "unauthorized", message: "bad token" } },
        exitCode: 3,
      },
      {
        reply: { status: 403, body: { error: "machine_subject_required", message: "no" } },
        exitCode: 3,
      },
      {
        reply: { status: 404, body: { error: "recipient_not_found", message: "nobody" } },
        exitCode: 4,
      },
      {
        reply: {
          status: 409,
          body: {
            error: "recipient_ambiguous",
            message: "two",
            candidates: [{ participantId: "a" }],
          },
        },
        exitCode: 4,
      },
      {
        reply: {
          status: 403,
          body: { error: "policy_refused", message: "cannot receive", reason: "x" },
        },
        exitCode: 5,
      },
    ];
    for (const testCase of cases) {
      yield* withStub(
        () => testCase.reply,
        (stub) =>
          Effect.gen(function* () {
            process.exitCode = undefined;
            yield* runCli(sendArgs(stub.origin));
            assert.equal(
              process.exitCode,
              testCase.exitCode,
              `HTTP ${String(testCase.reply.status)}`,
            );
            const output = lastJson();
            assert.equal(output.ok, false);
            assert.equal(output.exit_code, testCase.exitCode);
            assert.equal(output.error, (testCase.reply.body as { error: string }).error);
            if (testCase.reply.status === 409) assert.isArray(output.candidates);
          }),
      );
    }
  }),
);

it.live("fails fast with exit 6 when nothing listens at the origin", () =>
  Effect.gen(function* () {
    const closedOrigin = yield* withStub(
      () => ({ status: 200, body: {} }),
      (stub) => Effect.succeed(stub.origin),
    );
    const startedAt = yield* Clock.currentTimeMillis;
    yield* runCli(sendArgs(closedOrigin).filter((arg) => arg !== "--json"));
    const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
    assert.equal(process.exitCode, A2A_EXIT_CODES.unreachable);
    assert.isBelow(elapsed, 2_000);
    assert.match(errored.at(-1) ?? "", /server_unreachable/);
  }),
);

it.live(
  "treats a missing recipient as a usage error and a missing token as unauthenticated, before any request",
  () =>
    withStub(
      () => ({ status: 200, body: receipt }),
      (stub) =>
        Effect.gen(function* () {
          yield* runCli([
            "a2a",
            "send",
            "--origin",
            stub.origin,
            "--token",
            "t",
            "--message",
            "m",
            "--json",
          ]);
          assert.equal(process.exitCode, A2A_EXIT_CODES.usage);
          assert.equal(lastJson().error, "usage");

          process.exitCode = undefined;
          yield* runCli(sendArgs(stub.origin, []));
          assert.equal(process.exitCode, A2A_EXIT_CODES.unauthenticated);
          assert.equal(lastJson().error, "token_required");
          assert.equal(stub.requests.length, 0);
        }),
    ),
);

it.live("lists the roster as one line per participant and answers whoami", () => {
  const roster = {
    participants: [
      {
        participantId: "agent:j5:a2a:thread:sentinel",
        kind: "agent",
        squadronId: "squadron:monitoring",
        squadronName: "Monitoring",
        displayName: "obs-sentinel",
        threadId: "thread:sentinel",
        archived: false,
        canReceiveMessage: true,
        acceptsUrgency: false,
        liveness: {
          state: "idle",
          runStatus: "completed",
          latestRunStartedAt: null,
          latestRunCompletedAt: "2026-09-15T12:00:00.000Z",
          lastError: null,
        },
      },
      {
        participantId: "machine:watchdog",
        kind: "machine",
        squadronId: "squadron:monitoring",
        squadronName: "Monitoring",
        displayName: "watchdog",
        threadId: null,
        archived: false,
        canReceiveMessage: false,
        acceptsUrgency: false,
        liveness: null,
      },
    ],
  };
  const whoami = {
    participant: {
      participantId: "machine:watchdog",
      squadronId: "squadron:monitoring",
      squadronName: "Monitoring",
      name: "watchdog",
      createdAt: "2026-09-15T00:00:00.000Z",
    },
    server: { version: "0.0.39" },
  };
  return withStub(
    (request) =>
      request.url === "/api/j5/a2a/roster"
        ? { status: 200, body: roster }
        : { status: 200, body: whoami },
    (stub) =>
      Effect.gen(function* () {
        yield* runCli(["a2a", "list", "--origin", stub.origin, "--token", "t"]);
        assert.equal(process.exitCode, undefined);
        const lines = (logged.at(-1) ?? "").split("\n");
        assert.deepStrictEqual(lines, [
          "agent\tagent:j5:a2a:thread:sentinel\tobs-sentinel\tMonitoring\tidle/completed\treachable",
          "machine\tmachine:watchdog\twatchdog\tMonitoring\t-\tno-receive",
        ]);

        yield* runCli(["a2a", "whoami", "--origin", stub.origin, "--token", "t", "--json"]);
        assert.equal(process.exitCode, undefined);
        const output = lastJson();
        assert.equal(output.ok, true);
        assert.deepStrictEqual(output.participant, whoami.participant);
        assert.equal(output.origin, stub.origin);
      }),
  );
});
