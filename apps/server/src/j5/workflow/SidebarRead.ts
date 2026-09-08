import { WorkflowEntry } from "@j5/workflow-contracts/sidebar";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const decodeEntries = Schema.decodeUnknownEffect(Schema.Array(WorkflowEntry));
/** Bounded presentation projection; does not load artifact bodies or alter pinned execution. */
export const readWorkflowEntries = Effect.fn("Workflow.readEntries")(function* (
  squadronId: string,
  query: string,
  offset: number,
  limit = 50,
) {
  const sql = yield* SqlClient.SqlClient;
  const boundedLimit = Math.min(100, Math.max(1, limit));
  const counts = yield* sql<{ total: number; waitingApprovalCount: number }>`SELECT
    count(*) AS total,
    sum(CASE WHEN status = 'waiting_approval' THEN 1 ELSE 0 END) AS waitingApprovalCount
    FROM j5_workflow_runs
    WHERE (${squadronId} = '' OR squadron_id = ${squadronId})
      AND (${query} = '' OR instr(lower(coalesce(json_extract(payload, '$.inputs.request'), '')), lower(${query})) > 0)`;
  const rows = yield* sql`SELECT id, squadron_id AS squadronId,
    substr(coalesce(json_extract(payload, '$.inputs.request'), 'Development workflow'), 1, 240) AS title,
    json_extract(payload, '$.phase') AS phase, status, revision,
    json_extract(payload, '$.gate.revision') AS gateRevision,
    json_extract(payload, '$.updatedAt') AS updatedAt
    FROM j5_workflow_runs
    WHERE (${squadronId} = '' OR squadron_id = ${squadronId})
      AND (${query} = '' OR instr(lower(coalesce(json_extract(payload, '$.inputs.request'), '')), lower(${query})) > 0)
    ORDER BY CASE status WHEN 'waiting_approval' THEN 0 WHEN 'blocked' THEN 1 WHEN 'failed' THEN 2 WHEN 'running' THEN 3 WHEN 'cancelling' THEN 4 ELSE 5 END, rowid DESC
    LIMIT ${boundedLimit + 1} OFFSET ${offset}`;
  return {
    runs: yield* decodeEntries(rows.slice(0, boundedLimit)),
    hasMore: rows.length > boundedLimit,
    total: counts[0]?.total ?? 0,
    waitingApprovalCount: counts[0]?.waitingApprovalCount ?? 0,
  };
});

export const readWorkflowThreadParent = Effect.fn("Workflow.readThreadParent")(function* (
  threadId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    runId: string;
    squadronId: string;
    title: string;
  }>`SELECT r.id AS runId, r.squadron_id AS squadronId,
    substr(coalesce(json_extract(r.payload, '$.inputs.request'), 'Development workflow'), 1, 240) AS title
    FROM j5_workflow_actions a
    JOIN j5_workflow_runs r ON r.id = a.run_id
    WHERE a.identity = ${threadId} OR a.identity LIKE ${`${threadId}/%`}
    ORDER BY r.rowid DESC LIMIT 1`;
  return rows[0] ?? null;
});
