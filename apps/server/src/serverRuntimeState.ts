import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { writeFileStringAtomically } from "./atomicWrite.ts";
import type * as ServerConfig from "./config.ts";
import { formatHostForUrl, isWildcardHost } from "./startupAccess.ts";

export const PersistedServerRuntimeState = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  host: Schema.optional(Schema.String),
  port: Schema.Int,
  origin: Schema.String,
  // Present when the server fronts a dev web server (VITE_DEV_SERVER_URL).
  // Dev is single-origin: browsers must pair through this URL, not `origin`.
  devUrl: Schema.optional(Schema.String),
  startedAt: Schema.String,
});
export type PersistedServerRuntimeState = typeof PersistedServerRuntimeState.Type;

export class ServerRuntimeStateError extends Schema.TaggedErrorClass<ServerRuntimeStateError>()(
  "ServerRuntimeStateError",
  {
    operation: Schema.Literals(["persist", "read", "decode", "clear"]),
    statePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} server runtime state at ${this.statePath}.`;
  }
}

export class StateDirectoryAlreadyInUseError extends Schema.TaggedErrorClass<StateDirectoryAlreadyInUseError>()(
  "StateDirectoryAlreadyInUseError",
  {
    stateDir: Schema.String,
    pid: Schema.optional(Schema.Int),
  },
) {
  override get message(): string {
    return `State directory '${this.stateDir}' is already in use by ${this.pid === undefined ? "another server (PID not yet available)" : `server pid ${this.pid}`}. Stop that server or pass a different --base-dir.`;
  }
}

const decodePersistedServerRuntimeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedServerRuntimeState),
);

const runtimeOriginForConfig = (
  config: Pick<ServerConfig.ServerConfig["Service"], "host">,
  port: number,
): PersistedServerRuntimeState["origin"] => {
  const hostname =
    config.host && !isWildcardHost(config.host) ? formatHostForUrl(config.host) : "127.0.0.1";
  return `http://${hostname}:${port}`;
};

export const makePersistedServerRuntimeState = (input: {
  readonly config: Pick<ServerConfig.ServerConfig["Service"], "host" | "devUrl">;
  readonly port: number;
}): Effect.Effect<PersistedServerRuntimeState> =>
  Effect.map(DateTime.now, (now) => ({
    version: 1,
    pid: process.pid,
    ...(input.config.host ? { host: input.config.host } : {}),
    port: input.port,
    origin: runtimeOriginForConfig(input.config, input.port),
    ...(input.config.devUrl ? { devUrl: input.config.devUrl.toString() } : {}),
    startedAt: DateTime.formatIso(now),
  }));

export const persistServerRuntimeState = (input: {
  readonly path: string;
  readonly state: PersistedServerRuntimeState;
}) =>
  writeFileStringAtomically({
    filePath: input.path,
    contents: `${JSON.stringify(input.state)}\n`,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ServerRuntimeStateError({
          operation: "persist",
          statePath: input.path,
          cause,
        }),
    ),
  );

export const clearPersistedServerRuntimeState = (path: string, ownerPid?: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (ownerPid !== undefined) {
      const state = yield* readPersistedServerRuntimeState(path);
      if (Option.isNone(state) || state.value.pid !== ownerPid) return;
    }
    yield* fs.remove(path, { force: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerRuntimeStateError({
            operation: "clear",
            statePath: path,
            cause,
          }),
      ),
      Effect.catchTags({
        ServerRuntimeStateError: (error) =>
          Effect.logWarning(error.message).pipe(
            Effect.annotateLogs({
              operation: error.operation,
              statePath: error.statePath,
              cause: error,
            }),
          ),
      }),
    );
  });

/**
 * Report whether the pid recorded in a persisted runtime state is still
 * running. Signal 0 delivers nothing; it only reports whether the pid exists.
 * EPERM means it exists but belongs to another user, which still counts as
 * alive.
 */
export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

const readServerRuntimeState = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(path).pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(
                new ServerRuntimeStateError({
                  operation: "read",
                  statePath: path,
                  cause,
                }),
              ),
        onSuccess: (contents) => Effect.succeed(Option.some(contents)),
      }),
    );
    if (Option.isNone(raw)) {
      return Option.none<PersistedServerRuntimeState>();
    }

    const trimmed = raw.value.trim();
    if (trimmed.length === 0) {
      return Option.none<PersistedServerRuntimeState>();
    }

    return yield* decodePersistedServerRuntimeState(trimmed).pipe(
      Effect.map(Option.some),
      Effect.mapError(
        (cause) =>
          new ServerRuntimeStateError({
            operation: "decode",
            statePath: path,
            cause,
          }),
      ),
    );
  });

export const readPersistedServerRuntimeState = (path: string) =>
  readServerRuntimeState(path).pipe(
    Effect.catchTags({
      ServerRuntimeStateError: (error) =>
        Effect.logWarning(error.message).pipe(
          Effect.annotateLogs({
            operation: error.operation,
            statePath: error.statePath,
            cause: error,
          }),
          Effect.as(Option.none<PersistedServerRuntimeState>()),
        ),
    }),
  );

/** Hold ownership until the enclosing server scope has finished shutting down. */
export const claimStateDirectory = Effect.fn("claimStateDirectory")(function* (statePath: string) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const stateDir = path.dirname(statePath);
  yield* fs.makeDirectory(stateDir, { recursive: true });
  const filename = path.join(stateDir, "server-ownership.sqlite");
  const clientLayer =
    process.versions.bun !== undefined
      ? (yield* Effect.promise(() => import("@effect/sql-sqlite-bun/SqliteClient"))).layer({
          filename,
          disableWAL: true,
        })
      : (yield* Effect.promise(() => import("@t3tools/shared/nodeSqliteClient"))).layer({
          filename,
        });
  const context = yield* Layer.build(clientLayer);
  const sql = Context.get(context, SqlClient.SqlClient);
  yield* Effect.gen(function* () {
    yield* sql`PRAGMA busy_timeout = 0`;
    yield* sql`PRAGMA journal_mode = DELETE`;
    // Closing this dedicated connection releases the transaction, including on startup failure.
    // Keep the file: unlinking it could let another process lock a different inode.
    yield* sql`BEGIN EXCLUSIVE`;
  }).pipe(
    Effect.mapError((error) => {
      // node:sqlite exposes errcode; the shared classifier currently only reads errno/code.
      const cause = error.reason.cause;
      const code =
        Predicate.hasProperty(cause, "errcode") && typeof cause.errcode === "number"
          ? cause.errcode & 0xff
          : undefined;
      return error.reason._tag === "LockTimeoutError" || code === 5 || code === 6
        ? new StateDirectoryAlreadyInUseError({ stateDir })
        : error;
    }),
  );
  // Older servers do not claim the SQLite lock, so retain their runtime PID guard.
  const state = yield* readServerRuntimeState(statePath);
  if (Option.isSome(state) && state.value.pid !== process.pid && isProcessAlive(state.value.pid)) {
    return yield* new StateDirectoryAlreadyInUseError({ stateDir, pid: state.value.pid });
  }
});
