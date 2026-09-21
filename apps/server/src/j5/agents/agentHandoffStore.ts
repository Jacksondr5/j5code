import { AgentHandoff, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

type Row = {
  readonly thread_id: string;
  readonly project_id: string;
  readonly persona_id: string;
  readonly artifact: string;
  readonly path: string;
  readonly status: string;
  readonly run_id: string | null;
  readonly checked_at: string;
};

const decodeHandoff = Schema.decodeUnknownSync(AgentHandoff);
const fromRow = (row: Row): AgentHandoff =>
  decodeHandoff({
    threadId: row.thread_id,
    projectId: row.project_id,
    personaId: row.persona_id,
    artifact: row.artifact,
    path: row.path,
    status: row.status,
    runId: row.run_id,
    checkedAt: row.checked_at,
  });

/** SQL access to `j5_agent_handoffs` (J5 migration 12); one row per saved-agent task. */
export const makeAgentHandoffStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    get: (threadId: ThreadId) =>
      sql<Row>`SELECT * FROM j5_agent_handoffs WHERE thread_id = ${threadId}`.pipe(
        Effect.map((rows) => (rows[0] === undefined ? null : fromRow(rows[0]))),
      ),
    list: (input: { readonly threadIds?: ReadonlyArray<ThreadId> | undefined }) =>
      (input.threadIds === undefined
        ? sql<Row>`SELECT * FROM j5_agent_handoffs ORDER BY checked_at DESC LIMIT 500`
        : input.threadIds.length === 0
          ? Effect.succeed([] as ReadonlyArray<Row>)
          : sql<Row>`SELECT * FROM j5_agent_handoffs WHERE thread_id IN ${sql.in(input.threadIds)} ORDER BY checked_at DESC`
      ).pipe(Effect.map((rows) => rows.map(fromRow))),
    upsert: (handoff: AgentHandoff) =>
      sql`
        INSERT INTO j5_agent_handoffs (thread_id, project_id, persona_id, artifact, path, status, run_id, checked_at)
        VALUES (${handoff.threadId}, ${handoff.projectId}, ${handoff.personaId}, ${handoff.artifact}, ${handoff.path}, ${handoff.status}, ${handoff.runId}, ${handoff.checkedAt})
        ON CONFLICT(thread_id) DO UPDATE SET
          status = excluded.status,
          run_id = excluded.run_id,
          checked_at = excluded.checked_at
      `.pipe(Effect.asVoid),
  };
});
export type AgentHandoffStore = Effect.Success<typeof makeAgentHandoffStore>;
