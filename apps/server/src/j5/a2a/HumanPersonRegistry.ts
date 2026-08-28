import * as NodeCrypto from "node:crypto";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ParticipantId } from "./contracts.ts";

interface HumanPersonRow {
  readonly person_id: string;
}

export const listRegisteredHumanPersonIds = Effect.fn(
  "j5.a2a.humanPersonRegistry.listRegisteredHumanPersonIds",
)(function* (sql: SqlClient.SqlClient) {
  const rows = yield* sql<HumanPersonRow>`
    SELECT person_id
    FROM j5_a2a_human_person
    ORDER BY person_id
  `;
  return rows.map((row) => ParticipantId.make(row.person_id));
});

export const isRegisteredHumanPerson = Effect.fn(
  "j5.a2a.humanPersonRegistry.isRegisteredHumanPerson",
)(function* (sql: SqlClient.SqlClient, personId: ParticipantId) {
  const rows = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count
    FROM j5_a2a_human_person
    WHERE person_id = ${personId}
  `;
  return (rows[0]?.count ?? 0) === 1;
});

export const ensureLocalOperatorHumanPerson = Effect.fn(
  "j5.a2a.humanPersonRegistry.ensureLocalOperatorHumanPerson",
)(function* (sql: SqlClient.SqlClient) {
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const existing = yield* sql<HumanPersonRow>`
        SELECT person_id
        FROM j5_a2a_human_person
        WHERE is_local_operator = 1
        LIMIT 1
      `;
      if (existing[0] !== undefined) return ParticipantId.make(existing[0].person_id);

      const personId = ParticipantId.make(`human:${NodeCrypto.randomUUID()}`);
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at)
        VALUES (${personId}, 1, ${createdAt})
        ON CONFLICT DO NOTHING
      `;
      const inserted = yield* sql<HumanPersonRow>`
        SELECT person_id
        FROM j5_a2a_human_person
        WHERE is_local_operator = 1
        LIMIT 1
      `;
      return ParticipantId.make(inserted[0]!.person_id);
    }),
  );
});

/** Runtime startup mints one durable host-local operator without Squadron state. */
export const humanPersonRegistryLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* ensureLocalOperatorHumanPerson(sql);
  }),
);
