import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The newest V2 thread event's sequence, i.e. where a J5 stream daemon starts
 * `streamStoredEventsFrom` when the server boots. It must read the same rows that stream reads,
 * so it matches upstream's `EventStoreV2.latestSequence()` (`latestAgentSequence`): V2 thread
 * events in `orchestration_events`. Reading the retired `orchestration_v2_events` table, which
 * nothing writes since the V2 event-source migration, returned 0 and replayed all history on
 * every boot (#349).
 */
export const latestStoredEventSequence = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly sequence: number | null }>`
    SELECT MAX(sequence) AS sequence
    FROM orchestration_events
    WHERE application_event_version = 2
      AND aggregate_kind = 'thread'
  `;
  return rows[0]?.sequence ?? 0;
});
