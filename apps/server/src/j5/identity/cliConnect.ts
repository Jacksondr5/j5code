// @effect-diagnostics nodeBuiltinImport:off - reads the client secret from a file or stdin.
import * as NodeFS from "node:fs";

import { AuthAccessWriteScope } from "@t3tools/contracts";
import {
  J5_IDENTITY_CLI_JOIN_PATH,
  J5_IDENTITY_CLI_LEAVE_PATH,
  J5_IDENTITY_CLI_RETURN_URLS_PATH,
  type JoinConnectRequest,
  JoinedConnect,
  ReturnUrls,
} from "@t3tools/contracts/j5";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { authLocationFlags, resolveCliAuthConfig } from "../../cli/config.ts";
import * as ServerConfig from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { acquireServerOwnership } from "../../serverOwnership.ts";
import {
  clearPersistedServerRuntimeState,
  readLiveServerRuntimeState,
} from "../../serverRuntimeState.ts";
import { cliEnvironmentAuth } from "../sharing/AccessGate.ts";
import * as Identity from "./Identity.ts";

/**
 * `j5 auth connect join` and `leave`: an Owner's way, from the server's own machine, to trust a
 * J5 Connect or stop trusting it. A running server makes the change, so its open sockets see a
 * leave at once; with none running, it is made here while holding the home's lock.
 */

export class ConnectCommandError extends Schema.TaggedError<ConnectCommandError>()(
  "ConnectCommandError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.reason;
  }
}

const CLI_SESSION_TTL = Duration.minutes(2);
const SERVER_TIMEOUT = Duration.seconds(60);
const decodeJoined = Schema.decodeUnknownEffect(JoinedConnect);
const decodeReturnUrls = Schema.decodeUnknownEffect(ReturnUrls);

/** The client secret, from a file or, for `-`, stdin; never from the command line. */
const readSecret = (path: string) =>
  Effect.try({
    try: () => NodeFS.readFileSync(path === "-" ? 0 : path, "utf8").trim(),
    catch: (cause) =>
      new ConnectCommandError({
        reason: `Could not read the client secret from ${path === "-" ? "stdin" : path}.`,
        cause,
      }),
  }).pipe(
    Effect.filterOrFail(
      (secret) => secret.length > 0,
      () => new ConnectCommandError({ reason: "The client secret file is empty." }),
    ),
  );

const field = (body: unknown, name: string) =>
  typeof body === "object" && body !== null && name in body
    ? (body as Record<string, unknown>)[name]
    : undefined;

/** Asks the running server at `origin`, signed in as a short session revoked afterwards. */
const throughServer = Effect.fn("j5.identity.cli.throughServer")(function* (input: {
  readonly origin: string;
  readonly path: string;
  readonly body: unknown;
}) {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const client = yield* HttpClient.HttpClient;
  const reply = yield* Effect.acquireUseRelease(
    auth.issueSession({
      scopes: [AuthAccessWriteScope],
      label: "j5 auth connect",
      ttl: CLI_SESSION_TTL,
    }),
    (issued) =>
      HttpClientRequest.post(new URL(input.path, input.origin).toString()).pipe(
        HttpClientRequest.bearerToken(issued.token),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyJson(input.body),
        Effect.flatMap(client.execute),
        Effect.flatMap((response) =>
          response.text.pipe(
            Effect.map((text) => {
              try {
                return { status: response.status, body: JSON.parse(text) as unknown };
              } catch {
                return { status: response.status, body: null as unknown };
              }
            }),
          ),
        ),
        Effect.timeout(SERVER_TIMEOUT),
      ),
    (issued) => auth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new ConnectCommandError({
          reason: `The server at ${input.origin} did not answer, so the change may or may not have been made. Check before you retry.`,
          cause,
        }),
    ),
  );
  if (reply.status !== 200) {
    const message = field(reply.body, "message");
    return yield* new ConnectCommandError({
      reason:
        typeof message === "string"
          ? message
          : reply.status === 404
            ? `The server at ${input.origin} does not know this command. It may be an older build: restart it on this one.`
            : `The server at ${input.origin} refused (HTTP ${String(reply.status)}).`,
    });
  }
  return reply.body;
});

/**
 * Runs `viaServer` against the server running for the home, or `locally` while holding the
 * home's lock when none is.
 */
const change = Effect.fn("j5.identity.cli.change")(function* <A>(input: {
  readonly flags: { readonly baseDir: Option.Option<string>; readonly devUrl: Option.Option<URL> };
  readonly viaServer: (
    origin: string,
  ) => Effect.Effect<
    A,
    ConnectCommandError,
    EnvironmentAuth.EnvironmentAuth | HttpClient.HttpClient
  >;
  readonly locally: Effect.Effect<A, ConnectCommandError, Identity.Identity>;
}) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(input.flags, logLevel, { quietLogs: true });
  const runtime = <X, XE, XR>(layer: Layer.Layer<X, XE, XR>) =>
    layer.pipe(
      Layer.provide(ServerConfig.layer(config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
    );
  const running = yield* readLiveServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isSome(running)) {
    return yield* input
      .viaServer(running.value.origin)
      .pipe(
        Effect.provide(
          runtime(EnvironmentAuth.layerRuntime).pipe(Layer.merge(FetchHttpClient.layer)),
        ),
      );
  }
  return yield* acquireServerOwnership(config.serverRuntimeStatePath).pipe(
    Effect.provide(ProcessRunner.layer),
    Effect.andThen(input.locally),
    Effect.tap(() => clearPersistedServerRuntimeState(config.serverRuntimeStatePath)),
    Effect.provide(
      runtime(
        Identity.layer.pipe(
          Layer.provideMerge(cliEnvironmentAuth(EnvironmentAuth.layerRuntime)),
          Layer.provideMerge(ServerSecretStore.layer),
          Layer.provideMerge(FetchHttpClient.layer),
          Layer.provideMerge(ServerConfig.layer(config)),
        ),
      ),
    ),
    Effect.scoped,
  );
});

const addressesFlag = Flag.String("address").pipe(
  Flag.withDescription(
    "Another address this server is reached at, such as an HTTPS name in front of it. Repeat for several.",
  ),
  Flag.atLeast(0),
);

const redirectUrisCommand = Command.make("redirect-uris", {
  ...authLocationFlags,
  addresses: addressesFlag,
}).pipe(
  Command.withDescription(
    "Print the redirect URIs a J5 Connect's operator registers for this server before it joins.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const returnUrls = yield* change({
        flags,
        viaServer: (origin) =>
          throughServer({
            origin,
            path: J5_IDENTITY_CLI_RETURN_URLS_PATH,
            body: { addresses: flags.addresses },
          }).pipe(
            Effect.flatMap((body) =>
              decodeReturnUrls(body).pipe(
                Effect.map((decoded) => decoded.returnUrls),
                Effect.mapError(
                  (cause) =>
                    new ConnectCommandError({
                      reason: "The server's answer was unreadable.",
                      cause,
                    }),
                ),
              ),
            ),
          ),
        locally: Effect.flatMap(Identity.Identity, (identity) =>
          identity.returnUrls(flags.addresses),
        ),
      });
      yield* Console.log([...returnUrls, ""].join("\n"));
    }),
  ),
);

const joinCommand = Command.make("join", {
  ...authLocationFlags,
  issuer: Argument.String("issuer-url").pipe(
    Argument.withDescription("The J5 Connect's issuer URL, such as https://connect.example.com."),
  ),
  clientId: Flag.String("client-id").pipe(
    Flag.withDescription("The client id the J5 Connect's operator registered for this server."),
  ),
  clientSecretFile: Flag.String("client-secret-file").pipe(
    Flag.withDescription("A file holding the client's secret, or `-` to read it from stdin."),
  ),
  addresses: addressesFlag,
}).pipe(
  Command.withDescription(
    "Trust a J5 Connect to sign people in. Prints the redirect URIs to register if any are missing.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const secret = yield* readSecret(flags.clientSecretFile);
      const request: JoinConnectRequest = {
        issuer: flags.issuer,
        clientId: flags.clientId,
        clientSecret: secret,
        addresses: flags.addresses,
      };
      const joined = yield* change({
        flags,
        viaServer: (origin) =>
          throughServer({ origin, path: J5_IDENTITY_CLI_JOIN_PATH, body: request }).pipe(
            Effect.flatMap((body) =>
              decodeJoined(body).pipe(
                Effect.mapError(
                  (cause) =>
                    new ConnectCommandError({
                      reason: "The server's answer was unreadable.",
                      cause,
                    }),
                ),
              ),
            ),
          ),
        locally: Effect.gen(function* () {
          const identity = yield* Identity.Identity;
          return yield* identity.join({
            issuer: request.issuer,
            clientId: request.clientId,
            clientSecret: request.clientSecret,
            addresses: flags.addresses,
          });
        }).pipe(
          Effect.mapError((cause) => new ConnectCommandError({ reason: cause.message, cause })),
        ),
      });
      yield* Console.log(
        [
          `This server now trusts ${joined.issuer} (client ${joined.clientId}).`,
          "People sign in at these addresses:",
          ...joined.returnUrls.map((url) => `  ${new URL(url).origin}`),
          "",
        ].join("\n"),
      );
    }),
  ),
);

const leaveCommand = Command.make("leave", { ...authLocationFlags }).pipe(
  Command.withDescription(
    "Stop trusting the J5 Connect: clears its bindings and requests, and ends every session that came from sign-in.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      yield* change({
        flags,
        viaServer: (origin) =>
          throughServer({ origin, path: J5_IDENTITY_CLI_LEAVE_PATH, body: {} }).pipe(Effect.asVoid),
        locally: Effect.gen(function* () {
          const identity = yield* Identity.Identity;
          yield* identity.leave;
        }).pipe(
          Effect.mapError((cause) => new ConnectCommandError({ reason: cause.message, cause })),
        ),
      });
      yield* Console.log("This server no longer trusts a J5 Connect.\n");
    }),
  ),
);

/** `j5 auth connect`; upstream's `j5 auth connect-device` and `j5 connect` are other commands. */
export const authConnectCommand = Command.make("connect").pipe(
  Command.withDescription("Sign people in through a J5 Connect."),
  Command.withSubcommands([redirectUrisCommand, joinCommand, leaveCommand]),
);
