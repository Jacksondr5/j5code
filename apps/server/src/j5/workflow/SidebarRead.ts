import { WorkflowEntry } from "@j5/workflow-contracts/sidebar";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const decodeEntries = Schema.decodeUnknownEffect(Schema.Array(WorkflowEntry));
const selectColumns = `SELECT id, squadron_id AS squadronId, substr(title, 1, 240) AS title,
  phase, status, revision, gate_revision AS gateRevision,
  strftime('%Y-%m-%dT%H:%M:%fZ', activity_at / 1000.0, 'unixepoch') AS updatedAt
  FROM j5_workflow_runs`;
const order = `ORDER BY status_priority, activity_at DESC, creation_sequence DESC`;

export function makeRunFilter(squadronId: string, query: string, status: string) {
  const clauses: string[] = [];
  const parameters: Array<string> = [];
  if (squadronId.length > 0) {
    clauses.push("squadron_id=?");
    parameters.push(squadronId);
  }
  if (status.length > 0) {
    clauses.push("status=?");
    parameters.push(status);
  }
  if (query.length > 0) {
    clauses.push("instr(lower(title), ?)>0");
    parameters.push(query.toLocaleLowerCase());
  }
  return {
    sql: clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`,
    parameters,
  };
}

export const readWorkflowEntries = Effect.fn("Workflow.readEntries")(function* (
  squadronId: string,
  query: string,
  offset: number,
  limit = 50,
  status = "",
) {
  const sql = yield* SqlClient.SqlClient;
  const boundedLimit = Math.min(100, Math.max(1, limit));
  const filter = makeRunFilter(squadronId, query, status);
  const countRows = yield* sql.unsafe<{ total: number; waitingApprovalCount: number }>(
    `SELECT count(*) AS total,
      sum(CASE WHEN status='waiting_approval' THEN 1 ELSE 0 END) AS waitingApprovalCount
      FROM j5_workflow_runs${filter.sql}`,
    filter.parameters,
  );
  const rows = yield* sql.unsafe(`${selectColumns}${filter.sql} ${order} LIMIT ? OFFSET ?`, [
    ...filter.parameters,
    boundedLimit + 1,
    offset,
  ]);
  return {
    runs: yield* decodeEntries(rows.slice(0, boundedLimit)),
    hasMore: rows.length > boundedLimit,
    total: countRows[0]?.total ?? 0,
    waitingApprovalCount: countRows[0]?.waitingApprovalCount ?? 0,
  };
});

export const readWorkflowApprovalCount = Effect.fn("Workflow.readApprovalCount")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ count: number }>`SELECT count(*) AS count FROM j5_workflow_runs
    WHERE status='waiting_approval'`;
  return rows[0]?.count ?? 0;
});

export const readWorkflowThreadParent = Effect.fn("Workflow.readThreadParent")(function* (
  threadId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ runId: string; squadronId: string; title: string }>`SELECT
    r.id AS runId, r.squadron_id AS squadronId, substr(r.title, 1, 240) AS title
    FROM j5_workflow_actions a JOIN j5_workflow_runs r ON r.id=a.run_id
    WHERE a.identity=${threadId} OR a.identity LIKE ${`${threadId}/%`}
    ORDER BY r.creation_sequence DESC LIMIT 1`;
  return rows[0] ?? null;
});
