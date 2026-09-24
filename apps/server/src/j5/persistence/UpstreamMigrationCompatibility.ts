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
import renumber from "./reviewed-v2-renumber.v1.json" with { type: "json" };
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

const failed = (id: number, name: string) => (cause: unknown) =>
  new Migrator.MigrationError({
    kind: "Failed",
    message: `Migration "${id}_${name}" failed`,
    cause,
  });

// Keep the many-to-one source history as durable upgrade provenance.
const archiveHistory = Effect.fn("J5.archiveUpstreamMigrationHistory")(function* (
  sourceRef: string,
  rows: ReadonlyArray<typeof History.Type[number]>,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS j5_upstream_migration_history (
    source_ref TEXT NOT NULL,
    migration_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (source_ref, migration_id)
  )`;
  yield* sql`INSERT INTO j5_upstream_migration_history ${sql.insert(
    rows.map((row) => ({ source_ref: sourceRef, ...row })),
  )}`;
});

/**
 * Upgrades histories that upstream's ordinary migrator cannot: the pin's
 * `51 = OrchestrationV2` (renumbered to 54 upstream) and the older August and
 * September V2 histories. Only missing SQL runs; V2 is never replayed over an
 * existing V2 schema. Original IDs/names/timestamps are archived in
 * `j5_upstream_migration_history`. All SQL and history changes share the outer
 * transaction, including subsequent upstream migrations.
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

        if (history.some((row) => row.migration_id === 53 && row.name === "OrchestrationV2")) {
          return yield* badState(
            "53 = OrchestrationV2 is an upstream T3 Code V2 preview database; J5 does not share databases with T3 Code and does not upgrade them",
          );
        }
        const reviewedTarget = renumber.targetMigrations.map(({ id, name }) => [id, name] as const);
        if (
          migrationManifest.length !== reviewedTarget.length ||
          !migrationManifest.every(
            ([id, name], index) => reviewedTarget[index]?.[0] === id && reviewedTarget[index]?.[1] === name,
          )
        ) {
          return yield* badState("the candidate no longer matches the reviewed composition");
        }
        // The manifest was just verified to be the reviewed contiguous 1–55 list.
        const entry = (id: number) => migrationEntries[id - 1]!;
        const v2Id = 54;
        const v2 = entry(v2Id);

        const pin =
          history.length === renumber.sourceMigrations.length &&
          matches(renumber.sourceMigrations.map(({ id, name }) => [id, name] as const));
        if (pin) {
          yield* verifyHistoricalSchema(renumber.schema.objectNames, renumber.schema.sha256);
          const inserted = [51, 52, 53].map(entry);
          for (const [id, name, migration] of inserted) {
            yield* Effect.mapError(migration, failed(id, name));
          }
          yield* archiveHistory(
            renumber.sourceRef,
            history.filter((row) => row.migration_id === 51),
          );
          // UPDATE keeps the original completion timestamp of the V2 schema.
          yield* sql`UPDATE effect_sql_migrations SET migration_id = ${v2Id}
            WHERE migration_id = 51 AND name = ${v2[1]}`;
          yield* sql`INSERT INTO effect_sql_migrations ${sql.insert(
            inserted.map(([migration_id, name]) => ({ migration_id, name })),
          )}`;
          const executed = yield* runMigrations();
          const applied = [...inserted.map(([id, name]) => [id, name] as const), ...executed];
          yield* Effect.log("J5 upgraded upstream migration history").pipe(
            Effect.annotateLogs({
              source: `pin ${renumber.sourceRef}`,
              applied: applied.map(([id, name]) => `${id}_${name}`),
              remapped: [`51_${v2[1]} -> ${v2Id}_${v2[1]}`],
            }),
          );
          return applied;
        }

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
        const through = august ? 56 : history.length;
        const digest = august
          ? legacy.schema.sha256
          : collapse.schemas[String(through) as keyof typeof collapse.schemas];
        if (digest === undefined) return yield* badState("unreviewed historical prefix");
        yield* verifyHistoricalSchema(
          august ? legacy.schema.objectNames : collapse.schemaObjectNames,
          digest,
        );

        // Target SQL that precedes V2 in upstream's order, then only the V2 steps
        // this history has not completed.
        const firstMissing = august ? 41 : 48;
        const missing = migrationEntries.filter(([id]) => id >= firstMissing && id < v2Id);
        for (const [id, name, migration] of [
          ...missing,
          ...septemberV2RemainingSteps.filter(([id]) => id > through),
        ]) {
          yield* Effect.mapError(migration, failed(id, name));
        }

        const sourceRef = august ? legacy.ref : collapse.sourceRef;
        yield* archiveHistory(sourceRef, history);
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= ${firstMissing}`;
        const completed = [
          ...missing.map(([id, name]) => [id, name] as const),
          [v2Id, v2[1]] as const,
        ];
        yield* sql`INSERT INTO effect_sql_migrations ${sql.insert(
          completed.map(([migration_id, name]) => ({ migration_id, name })),
        )}`;
        const executed = yield* runMigrations();
        yield* Effect.log("J5 upgraded upstream migration history").pipe(
          Effect.annotateLogs({
            source: `${august ? "August" : "September"} ${sourceRef} through ${through}`,
            applied: [
              ...missing.map(([id, name]) => `${id}_${name}`),
              ...septemberV2RemainingSteps
                .filter(([id]) => id > through)
                .map(([id, name]) => `september ${id}_${name}`),
              ...executed.map(([id, name]) => `${id}_${name}`),
            ],
            remapped: history
              .filter(({ migration_id }) => migration_id >= firstMissing)
              .map(({ migration_id, name }) => `${migration_id}_${name} -> ${v2Id}_${v2[1]}`),
          }),
        );
        return [...completed, ...executed];
      }),
    );
  },
);
