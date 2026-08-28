import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import {
  ensureLocalOperatorHumanPerson,
  listRegisteredHumanPersonIds,
} from "./HumanPersonRegistry.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";

it.effect("mints one opaque local operator once without Squadron state", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const sql = yield* SqlClient.SqlClient;
    const first = yield* ensureLocalOperatorHumanPerson(sql);
    const restarted = yield* ensureLocalOperatorHumanPerson(sql);
    assert.equal(restarted, first);
    assert.match(first, /^human:[0-9a-f]{8}-[0-9a-f-]{27}$/);

    const people = yield* listRegisteredHumanPersonIds(sql);
    assert.deepStrictEqual(people, [first]);
    const domainCounts = yield* sql<{
      readonly events: number;
      readonly memberships: number;
      readonly squadrons: number;
    }>`
      SELECT
        (SELECT COUNT(*) FROM j5_a2a_squadron) AS squadrons,
        (SELECT COUNT(*) FROM j5_a2a_squadron_membership) AS memberships,
        (SELECT COUNT(*) FROM j5_a2a_comm_event) AS events
    `;
    assert.deepStrictEqual(domainCounts, [{ squadrons: 0, memberships: 0, events: 0 }]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
