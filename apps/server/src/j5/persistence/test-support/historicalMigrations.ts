import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { migrationEntries } from "../../../persistence/Migrations.ts";
import { septemberV2RemainingSteps } from "../SeptemberV2Steps.ts";
import SeptemberV2Base from "./SeptemberV2Base.ts";

const run = Migrator.make({});
export const historicalEntries = [
  ...migrationEntries.filter(([id]) => id <= 47),
  [48, "OrchestrationV2", SeptemberV2Base] as const,
  ...septemberV2RemainingSteps,
];
export const installHistorical = Effect.fn("test.installHistorical")(function* (
  kind: "august" | "september",
  through = 59,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = ON`;
  yield* run({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        historicalEntries
          .filter(([id]) =>
            kind === "august" ? id <= 40 || (id >= 48 && id <= 56) : id <= through,
          )
          .map(([id, name, migration]) => [
            `${kind === "august" && id >= 48 ? id - 7 : id}_${name}`,
            migration,
          ]),
      ),
    ),
  });
  yield* sql`UPDATE effect_sql_migrations SET created_at = '2026-08-15 12:00:00'`;
});

/**
 * A database created at pin 62aef8587c: current 1–50 plus `51 = OrchestrationV2`.
 * Upstream's 054 implementation and helpers are byte-identical to the pin's 051
 * (the migration audit enforces this), so they reproduce the pin schema exactly.
 */
export const installPin = Effect.fn("test.installPin")(function* (
  createdAt = "2026-09-10 12:00:00",
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = ON`;
  yield* run({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        migrationEntries
          .filter(([id]) => id <= 50 || id === 54)
          .map(([id, name, migration]) => [`${id === 54 ? 51 : id}_${name}`, migration]),
      ),
    ),
  });
  yield* sql`UPDATE effect_sql_migrations SET created_at = ${createdAt}`;
});

/** A pin database reached through the September bridge keeps that bridge's provenance. */
export const installPinWithSeptemberProvenance = Effect.fn(
  "test.installPinWithSeptemberProvenance",
)(function* (sourceRef: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* installPin();
  yield* sql`CREATE TABLE j5_upstream_migration_history (
    source_ref TEXT NOT NULL,
    migration_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (source_ref, migration_id)
  )`;
  yield* sql`INSERT INTO j5_upstream_migration_history ${sql.insert(
    historicalEntries.map(([migration_id, name]) => ({
      source_ref: sourceRef,
      migration_id,
      name,
      created_at: "2026-09-04 21:51:02",
    })),
  )}`;
});
