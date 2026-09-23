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
