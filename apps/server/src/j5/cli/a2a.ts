/**
 * `j5 a2a` - the machine-sender CLI: send, list, whoami, participant create,
 * token issue. Scripts and watchdogs use it in place of an agent session.
 *
 * Stable exit codes, kept in `A2A_EXIT_CODES`: 0 ok, 2 usage, 3 unauthenticated,
 * 4 recipient not found or ambiguous, 5 refused by policy, 6 server unreachable,
 * 1 anything else. Nothing here ever prompts: a missing input is a usage error.
 */
import { AuthA2ASendScope, AuthAdministrativeScopes } from "@t3tools/contracts";
import {
  A2ARosterResponse,
  J5_MACHINE_API_PATHS,
  MACHINE_PARTICIPANT_ID_PREFIX,
  MachineSendResponse,
  MachineWhoamiResponse,
  RegisterMachineParticipantResponse,
  machineParticipantIdForName,
  type A2ARosterEntry,
} from "@t3tools/contracts/j5";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import {
  authLocationFlags,
  type CliAuthLocationFlags,
  DurationFromString,
  resolveCliAuthConfig,
} from "../../cli/config.ts";
import { formatIssuedSession } from "../../cliAuthFormat.ts";
import * as ServerConfig from "../../config.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../../serverRuntimeState.ts";

export const A2A_EXIT_CODES = {
  ok: 0,
  failure: 1,
  usage: 2,
  unauthenticated: 3,
  recipientNotFound: 4,
  refused: 5,
  unreachable: 6,
} as const;

/** Documented ceiling for `--message`; larger payloads belong in a file the agent can read. */
export const A2A_MAX_MESSAGE_BYTES = 64 * 1024;

export class A2ACliFailure extends Data.TaggedError("A2ACliFailure")<{
  readonly exitCode: number;
  readonly error: string;
  readonly message: string;
  readonly extra?: Record<string, unknown> | undefined;
}> {}

interface Outcome {
  readonly json: Record<string, unknown>;
  readonly text: string;
}

const originFlag = Flag.string("origin").pipe(
  Flag.withDescription(
    "Server origin such as http://127.0.0.1:3773. Default: J5_ORIGIN, then the running local server under the base directory.",
  ),
  Flag.optional,
);
const tokenFlag = Flag.string("token").pipe(
  Flag.withDescription("Bearer token from `j5 a2a token issue`. Default: J5_TOKEN."),
  Flag.optional,
);
const tokenFileFlag = Flag.string("token-file").pipe(
  Flag.withDescription("File holding the bearer token. Default: J5_TOKEN_FILE."),
  Flag.optional,
);
const timeoutFlag = Flag.integer("timeout-ms").pipe(
  Flag.withDescription("Fail with exit 6 when the server does not answer in time."),
  Flag.withDefault(2000),
);
const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit one JSON object instead of human-readable output."),
  Flag.withDefault(false),
);

const connectionFlags = {
  ...authLocationFlags,
  origin: originFlag,
  token: tokenFlag,
  tokenFile: tokenFileFlag,
  timeoutMs: timeoutFlag,
  json: jsonFlag,
} as const;

interface ConnectionFlags extends CliAuthLocationFlags {
  readonly origin: Option.Option<string>;
  readonly token: Option.Option<string>;
  readonly tokenFile: Option.Option<string>;
  readonly timeoutMs: number;
  readonly json: boolean;
}

const envOption = (name: string) => Config.string(name).pipe(Config.option);

const usage = (message: string) =>
  new A2ACliFailure({ exitCode: A2A_EXIT_CODES.usage, error: "usage", message });

const requireFlag = <A>(value: Option.Option<A>, flag: string) =>
  Option.isSome(value) ? Effect.succeed(value.value) : Effect.fail(usage(`${flag} is required.`));

const resolveOrigin = Effect.fn("j5.a2a.cli.resolveOrigin")(function* (flags: ConnectionFlags) {
  const explicit = Option.orElse(flags.origin, () => Option.none<string>());
  const fromEnv = yield* envOption("J5_ORIGIN");
  const chosen = Option.orElse(explicit, () => fromEnv);
  if (Option.isSome(chosen)) return chosen.value.replace(/\/+$/, "");

  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  const state = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isSome(state) && isProcessAlive(state.value.pid)) return state.value.origin;
  return yield* new A2ACliFailure({
    exitCode: A2A_EXIT_CODES.unreachable,
    error: "server_unreachable",
    message: `No running J5 server was found under ${config.baseDir}. Start one, or pass --origin / J5_ORIGIN.`,
  });
});

const tryResolveToken = Effect.fn("j5.a2a.cli.tryResolveToken")(function* (flags: ConnectionFlags) {
  const fromEnv = yield* envOption("J5_TOKEN");
  const direct = Option.orElse(flags.token, () => fromEnv);
  if (Option.isSome(direct)) return Option.some(direct.value.trim());
  const fileFromEnv = yield* envOption("J5_TOKEN_FILE");
  const file = Option.orElse(flags.tokenFile, () => fileFromEnv);
  if (Option.isNone(file)) return Option.none<string>();
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs.readFileString(file.value).pipe(
    Effect.mapError(
      () =>
        new A2ACliFailure({
          exitCode: A2A_EXIT_CODES.unauthenticated,
          error: "token_file_unreadable",
          message: `Could not read the token file ${file.value}.`,
        }),
    ),
  );
  return Option.some(contents.trim());
});

const resolveToken = Effect.fn("j5.a2a.cli.resolveToken")(function* (flags: ConnectionFlags) {
  const token = yield* tryResolveToken(flags);
  if (Option.isSome(token) && token.value.length > 0) return token.value;
  return yield* new A2ACliFailure({
    exitCode: A2A_EXIT_CODES.unauthenticated,
    error: "token_required",
    message:
      "No token. Pass --token, set J5_TOKEN, or point --token-file at a token from `j5 a2a token issue`.",
  });
});

const readStdin = Effect.promise(async () => {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
});

/** `--message` accepts literal text, `@path` for a file, or `-` for stdin. */
const resolveMessage = Effect.fn("j5.a2a.cli.resolveMessage")(function* (raw: string) {
  const fs = yield* FileSystem.FileSystem;
  const text =
    raw === "-"
      ? yield* readStdin
      : raw.startsWith("@")
        ? yield* fs
            .readFileString(raw.slice(1))
            .pipe(Effect.mapError(() => usage(`Could not read the message file ${raw.slice(1)}.`)))
        : raw;
  if (text.trim().length === 0) return yield* usage("The message is empty.");
  if (Buffer.byteLength(text, "utf8") > A2A_MAX_MESSAGE_BYTES) {
    return yield* usage(
      `The message exceeds ${String(A2A_MAX_MESSAGE_BYTES)} bytes. Write it to a file the agent can read and send the path instead.`,
    );
  }
  return text;
});

interface ServerReply {
  readonly status: number;
  readonly body: unknown;
}

const parseJson = (text: string): unknown => {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const callServer = Effect.fn("j5.a2a.cli.callServer")(function* (input: {
  readonly origin: string;
  readonly token: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: unknown;
  readonly timeoutMs: number;
}) {
  const client = yield* HttpClient.HttpClient;
  const url = `${input.origin}${input.path}`;
  const base = (
    input.method === "GET" ? HttpClientRequest.get(url) : HttpClientRequest.post(url)
  ).pipe(HttpClientRequest.bearerToken(input.token), HttpClientRequest.acceptJson);
  const attempt = Effect.gen(function* () {
    const request =
      input.body === undefined ? base : yield* HttpClientRequest.bodyJson(base, input.body);
    const response = yield* client
      .execute(request)
      .pipe(Effect.timeout(Duration.millis(input.timeoutMs)));
    const text = yield* response.text;
    return { status: response.status, body: parseJson(text) } satisfies ServerReply;
  });
  return yield* attempt.pipe(
    Effect.mapError(
      (cause) =>
        new A2ACliFailure({
          exitCode: A2A_EXIT_CODES.unreachable,
          error: "server_unreachable",
          message: `Could not reach ${input.origin}: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    ),
  );
});

const failureFromReply = (
  reply: ServerReply,
  options: { readonly conflictExitCode?: number } = {},
) => {
  const body = isRecord(reply.body) ? reply.body : {};
  const error = typeof body.error === "string" ? body.error : `http_${String(reply.status)}`;
  const message =
    typeof body.message === "string"
      ? body.message
      : `The server answered HTTP ${String(reply.status)}.`;
  const exitCode =
    reply.status === 401
      ? A2A_EXIT_CODES.unauthenticated
      : reply.status === 403
        ? error === "policy_refused"
          ? A2A_EXIT_CODES.refused
          : A2A_EXIT_CODES.unauthenticated
        : reply.status === 404
          ? A2A_EXIT_CODES.recipientNotFound
          : reply.status === 409
            ? (options.conflictExitCode ?? A2A_EXIT_CODES.recipientNotFound)
            : reply.status === 400
              ? A2A_EXIT_CODES.usage
              : A2A_EXIT_CODES.failure;
  const { error: _error, message: _message, ...extra } = body;
  return new A2ACliFailure({ exitCode, error, message, extra });
};

const decodeReply = <S extends Schema.Top>(schema: S, body: unknown) =>
  Schema.decodeUnknownEffect(schema)(body).pipe(
    Effect.mapError(
      (cause) =>
        new A2ACliFailure({
          exitCode: A2A_EXIT_CODES.failure,
          error: "unexpected_response",
          message: `The server answered with an unexpected shape: ${cause.message}`,
        }),
    ),
  );

/** Every verb ends here: one line of JSON or text, and the process exit code. */
const runOutcome = <E, R>(json: boolean, body: Effect.Effect<Outcome, E | A2ACliFailure, R>) =>
  body.pipe(
    Effect.flatMap((outcome) =>
      Console.log(
        json
          ? JSON.stringify({ ok: true, exit_code: A2A_EXIT_CODES.ok, ...outcome.json })
          : outcome.text,
      ),
    ),
    Effect.catch((error) => {
      const failure =
        error instanceof A2ACliFailure
          ? error
          : new A2ACliFailure({
              exitCode: A2A_EXIT_CODES.failure,
              error: "failure",
              message: error instanceof Error ? error.message : String(error),
            });
      process.exitCode = failure.exitCode;
      return json
        ? Console.log(
            JSON.stringify({
              ok: false,
              exit_code: failure.exitCode,
              error: failure.error,
              message: failure.message,
              ...failure.extra,
            }),
          )
        : Console.error(`${failure.error}: ${failure.message}`);
    }),
    Effect.provide(FetchHttpClient.layer),
  );

const sendCommand = Command.make("send", {
  ...connectionFlags,
  to: Flag.string("to").pipe(
    Flag.withDescription("Recipient: participant id, thread id, or an agent's exact display name."),
    Flag.optional,
  ),
  message: Flag.string("message").pipe(
    Flag.withDescription("Message text, `@path` to read a file, or `-` to read stdin."),
    Flag.optional,
  ),
  clientRequestId: Flag.string("client-request-id").pipe(
    Flag.withDescription(
      "Idempotency key: retrying with the same id returns the original receipt.",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Send one plain message to an agent as the machine participant this token is bound to.",
  ),
  Command.withHandler((flags) =>
    runOutcome(
      flags.json,
      Effect.gen(function* () {
        const to = yield* requireFlag(flags.to, "--to");
        const rawMessage = yield* requireFlag(flags.message, "--message");
        const clientRequestId = yield* requireFlag(flags.clientRequestId, "--client-request-id");
        const message = yield* resolveMessage(rawMessage);
        const origin = yield* resolveOrigin(flags);
        const token = yield* resolveToken(flags);
        const reply = yield* callServer({
          origin,
          token,
          method: "POST",
          path: J5_MACHINE_API_PATHS.send,
          body: { to, message, clientRequestId },
          timeoutMs: flags.timeoutMs,
        });
        if (reply.status !== 200) return yield* failureFromReply(reply);
        const sent = yield* decodeReply(MachineSendResponse, reply.body);
        return {
          json: { ...sent },
          text: `Sent ${sent.result.messageId} to ${sent.receiver} as ${sent.sender} (durable at seq ${String(sent.result.durableAtSeq)}).`,
        } satisfies Outcome;
      }),
    ),
  ),
);

const formatRosterLine = (entry: A2ARosterEntry) =>
  [
    entry.kind,
    entry.participantId,
    entry.displayName ?? "-",
    entry.squadronName ?? "-",
    entry.liveness === null ? "-" : `${entry.liveness.state}/${entry.liveness.runStatus}`,
    entry.archived ? "archived" : entry.canReceiveMessage ? "reachable" : "no-receive",
  ].join("\t");

const listCommand = Command.make("list", connectionFlags).pipe(
  Command.withDescription(
    "List every participant with its measured liveness: kind, id, display name, Squadron, run state, reachability.",
  ),
  Command.withHandler((flags) =>
    runOutcome(
      flags.json,
      Effect.gen(function* () {
        const origin = yield* resolveOrigin(flags);
        const token = yield* resolveToken(flags);
        const reply = yield* callServer({
          origin,
          token,
          method: "GET",
          path: J5_MACHINE_API_PATHS.roster,
          timeoutMs: flags.timeoutMs,
        });
        if (reply.status !== 200) return yield* failureFromReply(reply);
        const roster = yield* decodeReply(A2ARosterResponse, reply.body);
        return {
          json: { participants: roster.participants },
          text: roster.participants.map(formatRosterLine).join("\n"),
        } satisfies Outcome;
      }),
    ),
  ),
);

const whoamiCommand = Command.make("whoami", connectionFlags).pipe(
  Command.withDescription(
    "Show the machine participant this token is bound to, its Squadron, and the server version.",
  ),
  Command.withHandler((flags) =>
    runOutcome(
      flags.json,
      Effect.gen(function* () {
        const origin = yield* resolveOrigin(flags);
        const token = yield* resolveToken(flags);
        const reply = yield* callServer({
          origin,
          token,
          method: "GET",
          path: J5_MACHINE_API_PATHS.whoami,
          timeoutMs: flags.timeoutMs,
        });
        if (reply.status !== 200) return yield* failureFromReply(reply);
        const identity = yield* decodeReply(MachineWhoamiResponse, reply.body);
        return {
          json: { ...identity, origin },
          text: `${identity.participant.participantId} in Squadron ${identity.participant.squadronName} (${identity.participant.squadronId}) — server v${identity.server.version} at ${origin}`,
        } satisfies Outcome;
      }),
    ),
  ),
);

/** Runs against the local auth control plane, exactly like `j5 auth`; no server is needed. */
const withLocalEnvironmentAuth = <A, E, R>(
  flags: CliAuthLocationFlags,
  run: (environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"]) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    return yield* Effect.flatMap(EnvironmentAuth.EnvironmentAuth, run).pipe(
      Effect.provide(
        Layer.mergeAll(EnvironmentAuth.runtimeLayer).pipe(
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
        ),
      ),
    );
  });

const participantCreateCommand = Command.make("create", {
  ...connectionFlags,
  squadron: Flag.string("squadron").pipe(
    Flag.withDescription("The Squadron id that becomes the machine's immutable home."),
    Flag.optional,
  ),
  name: Flag.string("name").pipe(
    Flag.withDescription(
      "Server-unique name, 1-64 lowercase letters, digits, or hyphens; the id becomes machine:<name>.",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Register a machine participant in a Squadron. Needs an orchestration:operate token, or runs on the server host with a temporary local admin session.",
  ),
  Command.withHandler((flags) =>
    runOutcome(
      flags.json,
      Effect.gen(function* () {
        const squadronId = yield* requireFlag(flags.squadron, "--squadron");
        const name = yield* requireFlag(flags.name, "--name");
        const origin = yield* resolveOrigin(flags);
        const register = (token: string) =>
          Effect.gen(function* () {
            const reply = yield* callServer({
              origin,
              token,
              method: "POST",
              path: J5_MACHINE_API_PATHS.machineParticipants,
              body: { squadronId, name },
              timeoutMs: flags.timeoutMs,
            });
            if (reply.status !== 200 && reply.status !== 201) {
              return yield* failureFromReply(reply, { conflictExitCode: A2A_EXIT_CODES.refused });
            }
            const registered = yield* decodeReply(RegisterMachineParticipantResponse, reply.body);
            return {
              json: { ...registered },
              text: `${registered.created ? "Registered" : "Already registered"} ${registered.participant.participantId} in Squadron ${registered.participant.squadronName}. Next: j5 a2a token issue --participant ${registered.participant.name}`,
            } satisfies Outcome;
          });
        const explicitToken = yield* tryResolveToken(flags);
        if (Option.isSome(explicitToken) && explicitToken.value.length > 0) {
          return yield* register(explicitToken.value);
        }
        return yield* withLocalEnvironmentAuth(flags, (environmentAuth) =>
          Effect.acquireUseRelease(
            environmentAuth.issueSession({
              scopes: AuthAdministrativeScopes,
              label: "j5 a2a participant create",
            }),
            (issued) => register(issued.token),
            (issued) =>
              environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
          ),
        );
      }),
    ),
  ),
);

const participantCommand = Command.make("participant").pipe(
  Command.withDescription("Manage machine participants."),
  Command.withSubcommands([participantCreateCommand]),
);

const normalizeMachineName = (value: string) =>
  value.startsWith(MACHINE_PARTICIPANT_ID_PREFIX)
    ? value.slice(MACHINE_PARTICIPANT_ID_PREFIX.length)
    : value;

const tokenIssueCommand = Command.make("issue", {
  ...authLocationFlags,
  participant: Flag.string("participant").pipe(
    Flag.withDescription("The machine participant name (or machine:<name>) the token is bound to."),
    Flag.optional,
  ),
  ttl: Flag.string("ttl").pipe(
    Flag.withSchema(DurationFromString),
    Flag.withDescription(
      "TTL such as `30d` or `1h`. Default: the auth control plane's session default.",
    ),
    Flag.optional,
  ),
  label: Flag.string("label").pipe(
    Flag.withDescription("Label shown in Settings → Connections. Default: the participant id."),
    Flag.optional,
  ),
  tokenOnly: Flag.boolean("token-only").pipe(
    Flag.withDescription("Print only the bearer token."),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Issue a bearer token bound to a machine participant with only the a2a:send scope. Runs on the server host against the local auth database.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      if (Option.isNone(flags.participant)) {
        process.exitCode = A2A_EXIT_CODES.usage;
        return yield* Console.error("usage: --participant is required.");
      }
      const name = normalizeMachineName(flags.participant.value.trim());
      const participantId = machineParticipantIdForName(name);
      yield* withLocalEnvironmentAuth(flags, (environmentAuth) =>
        Effect.gen(function* () {
          const issued = yield* environmentAuth.issueSession({
            scopes: [AuthA2ASendScope],
            subject: participantId,
            label: Option.getOrElse(flags.label, () => participantId),
            ...(Option.isSome(flags.ttl) ? { ttl: flags.ttl.value } : {}),
          });
          yield* Console.log(
            formatIssuedSession(issued, { json: flags.json, tokenOnly: flags.tokenOnly }),
          );
        }),
      );
    }),
  ),
);

const tokenCommand = Command.make("token").pipe(
  Command.withDescription("Mint tokens for machine participants."),
  Command.withSubcommands([tokenIssueCommand]),
);

export const a2aCommand = Command.make("a2a").pipe(
  Command.withDescription(
    "Send and inspect agent-to-agent messages from scripts, as a registered machine participant.",
  ),
  Command.withSubcommands([
    sendCommand,
    listCommand,
    whoamiCommand,
    participantCommand,
    tokenCommand,
  ]),
);
