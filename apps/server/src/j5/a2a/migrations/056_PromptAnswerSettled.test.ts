import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runJ5A2AMigrations } from "../Migrations.ts";

it.effect("backfills settled_at only for the answer whose command settled its prompt", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runJ5A2AMigrations({ toMigrationInclusive: 55 });
    yield* sql`
      CREATE TABLE orchestration_events (
        aggregate_kind TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        command_id TEXT,
        payload_json TEXT NOT NULL
      )
    `;
    const answer = (command: string) => sql`
      INSERT INTO j5_a2a_prompt_answer (
        thread_id, request_id, command_id, person_id, level, stored_prefix, answered_at
      )
      VALUES ('thread:one', 'request:one', ${command}, 'person:one', 'owner', '', '2026-11-07T00:00:00.000Z')
    `;
    yield* answer("command:settled");
    yield* answer("command:claim-only");
    const event = (command: string, type: string, requestId: string, at: string) => sql`
      INSERT INTO orchestration_events (
        aggregate_kind, stream_id, event_type, occurred_at, command_id, payload_json
      )
      VALUES ('thread', 'thread:one', ${type}, ${at}, ${command}, ${JSON.stringify({ id: requestId })})
    `;
    yield* event(
      "command:settled",
      "runtime-request.updated",
      "request:one",
      "2026-11-07T00:00:02.000Z",
    );
    yield* event(
      "command:settled",
      "runtime-request.updated",
      "request:one",
      "2026-11-07T00:00:01.000Z",
    );
    yield* event(
      "command:claim-only",
      "runtime-request.updated",
      "request:other",
      "2026-11-07T00:00:03.000Z",
    );
    yield* event(
      "command:claim-only",
      "thread.message-sent",
      "request:one",
      "2026-11-07T00:00:04.000Z",
    );

    yield* runJ5A2AMigrations();

    const rows = yield* sql<{ readonly command_id: string; readonly settled_at: string | null }>`
      SELECT command_id, settled_at FROM j5_a2a_prompt_answer ORDER BY command_id
    `;
    assert.deepStrictEqual(rows, [
      { command_id: "command:claim-only", settled_at: null },
      { command_id: "command:settled", settled_at: "2026-11-07T00:00:01.000Z" },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
