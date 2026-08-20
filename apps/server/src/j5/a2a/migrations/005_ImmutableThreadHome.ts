import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

class ImmutableThreadHomeConflictError extends Schema.TaggedErrorClass<ImmutableThreadHomeConflictError>()(
  "ImmutableThreadHomeConflictError",
  {
    conflicts: Schema.Array(
      Schema.Struct({
        threadId: Schema.String,
        joinCount: Schema.Number,
      }),
    ),
  },
) {
  override get message(): string {
    const details = this.conflicts
      .map(({ threadId, joinCount }) => `${threadId} (${joinCount} joins)`)
      .join(", ");
    return `Cannot enforce immutable thread homes; conflicting agent thread ids: ${details}. Repair duplicate participant.joined history before retrying migration 005.`;
  }
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const conflicts = yield* sql<{ readonly thread_id: string; readonly join_count: number }>`
    SELECT
      json_extract(payload, '$.participant.threadId') AS thread_id,
      COUNT(*) AS join_count
    FROM j5_a2a_comm_event
    WHERE kind = 'participant.joined'
      AND json_extract(payload, '$.participant.kind') = 'agent'
      AND json_extract(payload, '$.participant.threadId') IS NOT NULL
    GROUP BY json_extract(payload, '$.participant.threadId')
    HAVING COUNT(*) > 1
    ORDER BY thread_id
  `;
  if (conflicts.length > 0) {
    return yield* new ImmutableThreadHomeConflictError({
      conflicts: conflicts.map((row) => ({
        threadId: row.thread_id,
        joinCount: row.join_count,
      })),
    });
  }

  yield* sql`
    CREATE UNIQUE INDEX j5_a2a_comm_event_agent_home_thread_idx
    ON j5_a2a_comm_event(json_extract(payload, '$.participant.threadId'))
    WHERE kind = 'participant.joined'
      AND json_extract(payload, '$.participant.kind') = 'agent'
  `;
});
