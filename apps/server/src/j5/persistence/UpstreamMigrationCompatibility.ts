import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  migrationEntries,
  migrationManifest,
  runMigrations,
} from "../../persistence/Migrations.ts";
import legacy from "./legacy-upstream-migrations.v1.json" with { type: "json" };

const History = Schema.Array(
  Schema.Struct({
    migration_id: Schema.Int,
    name: Schema.String,
    created_at: Schema.String,
  }),
);
const SchemaObjects = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    type: Schema.String,
    tbl_name: Schema.String,
    sql: Schema.NullOr(Schema.String),
  }),
);
const encodeSignature = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.Array(Schema.NullOr(Schema.String)))),
);
const decodeHistory = Schema.decodeUnknownEffect(History);
const decodeSchemaObjects = Schema.decodeUnknownEffect(SchemaObjects);

const badState = (message: string) =>
  new Migrator.MigrationError({
    kind: "BadState",
    message: `J5 refused an unrecognized upstream migration state: ${message}`,
  });

const readHistory = Effect.fn("J5.readUpstreamMigrationHistory")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `;
  if (!tables.some(({ name }) => name === "effect_sql_migrations")) {
    if (tables.length !== 0) {
      return yield* badState("tables exist without migration history");
    }
    return [];
  }

  const rows = yield* sql`
    SELECT migration_id, name, created_at
    FROM effect_sql_migrations ORDER BY migration_id
  `;
  const history = yield* decodeHistory(rows).pipe(
    Effect.mapError(() => badState("invalid migration history rows")),
  );
  if (history.length === 0 && tables.length !== 1) {
    return yield* badState("tables exist with empty migration history");
  }
  return history;
});

const verifyLegacySchema = Effect.fn("J5.verifyLegacyUpstreamSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT name, type, tbl_name, sql FROM sqlite_master
    WHERE ${sql.in("name", legacy.schema.objectNames)} ORDER BY name
  `;
  const objects = yield* decodeSchemaObjects(rows).pipe(
    Effect.mapError(() => badState("invalid schema metadata")),
  );
  const signature = objects.map(({ name, type, tbl_name, sql: definition }) => [
    name,
    type,
    tbl_name,
    definition?.replace(/\s+/g, " ").trim() ?? null,
  ]);
  const encoded = yield* encodeSignature(signature);
  const digest = NodeCrypto.createHash("sha256").update(encoded).digest("hex");
  if (digest !== legacy.schema.sha256) {
    return yield* badState("legacy history does not match the reviewed schema");
  }
});

/**
 * Bridges the reviewed V2 migration renumbering before the ordinary upstream runner.
 * The outer transaction includes the missing SQL, preserved history timestamps,
 * and subsequent upstream migrations so a failure leaves the old database intact.
 */
export const runJ5CompatibleUpstreamMigrations = Effect.fn("J5.runCompatibleUpstreamMigrations")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const history = yield* readHistory();
        const isCurrentPrefix =
          history.length <= migrationManifest.length &&
          history.every(
            (row, index) =>
              row.migration_id === migrationManifest[index]?.[0] &&
              row.name === migrationManifest[index]?.[1],
          );

        if (isCurrentPrefix) {
          return yield* runMigrations();
        }

        const isReviewedLegacy =
          history.length === legacy.migrations.length &&
          history.every(
            (row, index) =>
              row.migration_id === legacy.migrations[index]?.id &&
              row.name === legacy.migrations[index]?.name,
          );
        if (!isReviewedLegacy) {
          return yield* badState(
            "history is neither a current prefix nor the reviewed legacy history",
          );
        }
        yield* verifyLegacySchema();

        // These nine implementations are unchanged; only their recorded ids move.
        const moved = history.filter(({ migration_id }) => migration_id >= 41);
        for (const row of moved) {
          const candidate = migrationManifest.find(([id]) => id === row.migration_id + 7);
          if (candidate?.[1] !== row.name) {
            return yield* badState("the candidate no longer matches the reviewed renumbering");
          }
        }

        const missing = migrationEntries.filter(([id]) => id >= 41 && id <= 47);
        for (const [, , migration] of missing) {
          yield* migration;
        }

        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 41`;
        yield* sql`INSERT INTO effect_sql_migrations ${sql.insert(
          moved.map((row) => ({ ...row, migration_id: row.migration_id + 7 })),
        )}`;
        yield* sql`INSERT INTO effect_sql_migrations ${sql.insert(
          missing.map(([migration_id, name]) => ({ migration_id, name })),
        )}`;

        const executed = yield* runMigrations();
        return [...missing.map(([id, name]) => [id, name] as const), ...executed];
      }),
    );
  },
);
