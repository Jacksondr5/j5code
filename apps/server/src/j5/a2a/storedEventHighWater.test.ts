import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { latestStoredEventSequence } from "./storedEventHighWater.ts";

const insertEvent = (input: {
  readonly sequence: number;
  readonly aggregateKind: "thread" | "project";
  readonly applicationEventVersion: 1 | 2;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_events (
        sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${input.sequence}, ${`event:${input.sequence}`}, ${input.aggregateKind},
        ${`${input.aggregateKind}:high-water`}, ${input.sequence}, 'thread.created',
        '2026-09-28T00:00:00.000Z', 'server', '{}', '{}', ${input.applicationEventVersion}
      )
    `;
  });

it.effect("starts from the newest V2 thread event in the table the stream reads", () =>
  Effect.gen(function* () {
    assert.equal(yield* latestStoredEventSequence, 0);

    yield* insertEvent({ sequence: 40, aggregateKind: "thread", applicationEventVersion: 2 });
    yield* insertEvent({ sequence: 41, aggregateKind: "thread", applicationEventVersion: 2 });
    // Neither a later project event nor a later V1 thread event moves the V2 thread stream.
    yield* insertEvent({ sequence: 50, aggregateKind: "project", applicationEventVersion: 2 });
    yield* insertEvent({ sequence: 60, aggregateKind: "thread", applicationEventVersion: 1 });

    assert.equal(yield* latestStoredEventSequence, 41);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
