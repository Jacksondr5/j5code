import { AgentHandoff, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

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

/** Read access to `j5_agent_handoffs` (J5 migration 12): rows recorded before handoffs were retired. */
export const makeAgentHandoffStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    list: (input: { readonly threadIds?: ReadonlyArray<ThreadId> | undefined }) =>
      (input.threadIds === undefined
        ? sql<Row>`SELECT * FROM j5_agent_handoffs ORDER BY checked_at DESC LIMIT 500`
        : input.threadIds.length === 0
          ? Effect.succeed([] as ReadonlyArray<Row>)
          : sql<Row>`SELECT * FROM j5_agent_handoffs WHERE thread_id IN ${sql.in(input.threadIds)} ORDER BY checked_at DESC`
      ).pipe(Effect.map((rows) => rows.map(fromRow))),
  };
});
