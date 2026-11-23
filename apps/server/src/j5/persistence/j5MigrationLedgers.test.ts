import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { runServicePreflight } from "../../cloud/servicePreflight.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "../../cloud/serviceProtocol.ts";
import { migrationManifest } from "../../persistence/Migrations.ts";
import { J5_A2A_MIGRATIONS_TABLE, migrationEntries } from "../a2a/Migrations.ts";
import {
  RUN_OBSERVABILITY_MIGRATIONS_TABLE,
  runObservabilityMigrationIds,
} from "../run-observability/Migrations.ts";
import { J5_BUILD_MIGRATION_HEADS, j5DatabaseMigrationHeads } from "./j5MigrationLedgers.ts";

const ledgers = [
  { table: J5_A2A_MIGRATIONS_TABLE, ids: migrationEntries.map(([id]) => id) },
  { table: RUN_OBSERVABILITY_MIGRATIONS_TABLE, ids: runObservabilityMigrationIds },
];

it.layer(NodeServices.layer)("J5 migration ledgers", (it) => {
  it.effect.each(ledgers)("blocks a database whose $table a newer build migrated", (ledger) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const databasePath = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "j5-preflight-" }),
        "statev2.sqlite",
      );
      const db = new NodeSqlite.DatabaseSync(databasePath);
      const record = (table: string, ids: ReadonlyArray<number>) => {
        db.exec(`CREATE TABLE "${table}" (migration_id INTEGER PRIMARY KEY, name TEXT)`);
        const insert = db.prepare(`INSERT INTO "${table}" VALUES (?, ?)`);
        for (const id of ids) insert.run(id, `Known${id}`);
      };
      record(
        "effect_sql_migrations",
        migrationManifest.map(([id]) => id),
      );
      for (const { table, ids } of ledgers) record(table, ids);
      const preflight = () =>
        runServicePreflight({ databasePath, launcherProtocol: SERVICE_LAUNCHER_PROTOCOL });

      // Upstream's ledger is current, so only the J5 ledger below can block.
      expect(preflight().status).toBe("ready");
      expect(j5DatabaseMigrationHeads(databasePath)).toEqual(J5_BUILD_MIGRATION_HEADS);

      const newerId = Math.max(...ledger.ids) + 1;
      db.prepare(`INSERT INTO "${ledger.table}" VALUES (?, ?)`).run(newerId, "FromNightly");
      db.close();
      const result = preflight();
      expect(result.status).toBe("blocked");
      expect(result.status === "blocked" ? result.reason : "").toContain(
        `${ledger.table} ${newerId}_FromNightly`,
      );
      // Servers report these heads, so a track switch sees a database a newer build migrated.
      expect(j5DatabaseMigrationHeads(databasePath)).toEqual({
        ...J5_BUILD_MIGRATION_HEADS,
        [ledger.table]: newerId,
      });

      // A database that exists but cannot be read has unknown heads.
      const unreadable = path.join(path.dirname(databasePath), "unreadable.sqlite");
      yield* fs.writeFileString(unreadable, "not a database");
      expect(j5DatabaseMigrationHeads(unreadable)).toBeUndefined();
    }),
  );
});
