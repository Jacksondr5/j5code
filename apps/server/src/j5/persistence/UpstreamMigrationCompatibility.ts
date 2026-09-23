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
import collapse from "./reviewed-v2-collapse.v1.json" with { type: "json" };
import { septemberV2RemainingSteps } from "./SeptemberV2Steps.ts";
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

const verifyHistoricalSchema = Effect.fn("J5.verifyHistoricalUpstreamSchema")(function* (
  objectNames: ReadonlyArray<string>,
  expectedDigest: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT name, type, tbl_name, sql FROM sqlite_master
    WHERE ${sql.in("name", objectNames)} ORDER BY name
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
  const encoded = yield* encodeSignature(signature).pipe(
    Effect.mapError(() => badState("invalid schema signature")),
  );
  const digest = NodeCrypto.createHash("sha256").update(encoded).digest("hex");
  if (digest !== expectedDigest) {
    return yield* badState("historical migration history does not match the reviewed schema");
  }
});

/**
 * Completes only missing historical steps before recording upstream's composed V2
 * migration. Original IDs/names/timestamps are retained separately; the composed
 * row is timestamped when this upgrade completes. All SQL and history changes
 * share the outer transaction, including subsequent upstream migrations.
 */
export const runJ5CompatibleUpstreamMigrations = Effect.fn("J5.runCompatibleUpstreamMigrations")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const history = yield* readHistory();
        const matches = (manifest: ReadonlyArray<readonly [number, string]>) =>
          history.length <= manifest.length &&
          history.every(
            (row, index) =>
              row.migration_id === manifest[index]?.[0] && row.name === manifest[index]?.[1],
          );
        if (matches(migrationManifest)) return yield* runMigrations();

        const august =
          history.length === legacy.migrations.length &&
          matches(legacy.migrations.map(({ id, name }) => [id, name] as const));
        const september =
          history.length >= 48 &&
          matches(collapse.sourceMigrations.map(({ id, name }) => [id, name] as const));
        if (!august && !september) {
          return yield* badState(
            "history is neither a current prefix nor a reviewed historical history",
          );
        }
        if (
          !collapse.targetMigrations.every(
            (row, index) =>
              migrationManifest[index]?.[0] === row.id &&
              migrationManifest[index]?.[1] === row.name,
          )
        ) {
          return yield* badState("the candidate no longer matches the reviewed composition");
        }
        const through = august ? 56 : history.length;
        const digest = august
          ? legacy.schema.sha256
          : collapse.schemas[String(through) as keyof typeof collapse.schemas];
        if (digest === undefined) return yield* badState("unreviewed historical prefix");
        yield* verifyHistoricalSchema(
          august ? legacy.schema.objectNames : collapse.schemaObjectNames,
          digest,
        );

        const missing = migrationEntries.filter(([id]) => id >= (august ? 41 : 48) && id <= 50);
        for (const [id, name, migration] of [
          ...missing,
          ...septemberV2RemainingSteps.filter(([id]) => id > through),
        ]) {
          yield* Effect.mapError(
            migration,
            (cause) =>
              new Migrator.MigrationError({
                kind: "Failed",
                message: `Migration "${id}_${name}" failed`,
                cause,
              }),
          );
        }

        // Keep the many-to-one source history as durable upgrade provenance.
        yield* sql`CREATE TABLE IF NOT EXISTS j5_upstream_migration_history (
          source_ref TEXT NOT NULL,
          migration_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (source_ref, migration_id)
        )`;
        yield* sql`INSERT INTO j5_upstream_migration_history ${sql.insert(
          history.map((row) => ({ source_ref: august ? legacy.ref : collapse.sourceRef, ...row })),
        )}`;
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= ${august ? 41 : 48}`;
        const completed = [
          ...missing.map(([id, name]) => [id, name] as const),
          [51, "OrchestrationV2"] as const,
        ];
        yield* sql`INSERT INTO effect_sql_migrations ${sql.insert(
          completed.map(([migration_id, name]) => ({ migration_id, name })),
        )}`;
        const executed = yield* runMigrations();
        return [...completed, ...executed];
      }),
    );
  },
);
