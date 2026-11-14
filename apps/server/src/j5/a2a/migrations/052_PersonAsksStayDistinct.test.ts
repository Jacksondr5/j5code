import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runJ5A2AMigrations } from "../Migrations.ts";

it.effect("allows several open Exchanges to a person and still one per pair of agents", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runJ5A2AMigrations({ toMigrationInclusive: 51 });
    yield* runJ5A2AMigrations();
    yield* sql`PRAGMA foreign_keys = OFF`;
    const open = (id: string, receiver: string) => sql`
      INSERT INTO j5_a2a_exchange (
        project_id, exchange_id, sender_id, receiver_id, status, intent, opened_seq, created_at,
        updated_at
      )
      VALUES (
        'project:one', ${id}, 'agent:one', ${receiver}, 'open', 'Intent', 1,
        '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z'
      )
    `;
    yield* open("exchange:person-1", "human:one");
    yield* open("exchange:person-2", "human:one");
    yield* open("exchange:everyone-1", "human:everyone-here");
    yield* open("exchange:everyone-2", "human:everyone-here");
    yield* open("exchange:agent-1", "agent:two");
    const second = yield* Effect.flip(open("exchange:agent-2", "agent:two"));
    assert.include(String(second.cause), "UniqueViolation");
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
