import { ThreadId } from "@t3tools/contracts";
import type { PlaybookCheckpoint, PlaybookCheckpointAnswer } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { playbookError } from "./definition.ts";

import { reachableThreadQuery, type SessionReach } from "../sharing/PersonAccess.ts";

type Row = {
  request_id: string;
  run_id: string;
  owner_thread_id: string;
  step_id: string;
  step_title: string;
  summary: string;
  status: PlaybookCheckpoint["status"];
  created_at: string;
  answered_at: string | null;
  reason: string | null;
};
const present = (row: Row): PlaybookCheckpoint => ({
  requestId: row.request_id,
  runId: row.run_id,
  ownerThreadId: ThreadId.make(row.owner_thread_id),
  stepId: row.step_id,
  stepTitle: row.step_title,
  summary: row.summary,
  status: row.status,
  createdAt: row.created_at,
  answeredAt: row.answered_at,
  reason: row.reason,
});

export const makePlaybookCheckpoints = (sql: SqlClient.SqlClient) => {
  const current = Effect.fn("PlaybookCheckpoints.current")(function* (runId: string) {
    const rows = yield* sql<Row>`SELECT checkpoint.* FROM j5_playbook_checkpoint checkpoint
      JOIN j5_playbook_run run ON run.checkpoint_request_id = checkpoint.request_id WHERE run.run_id = ${runId}`;
    return rows[0] ? present(rows[0]) : null;
  });
  const close = Effect.fn("PlaybookCheckpoints.close")(function* (
    runId: string,
    timestamp: string,
  ) {
    yield* sql`UPDATE j5_playbook_checkpoint SET status = 'closed', answered_at = ${timestamp}
      WHERE run_id = ${runId} AND status = 'pending'`;
    yield* sql`UPDATE j5_playbook_run SET checkpoint_request_id = NULL WHERE run_id = ${runId}`;
  });
  const open = Effect.fn("PlaybookCheckpoints.open")(function* (request: PlaybookCheckpoint) {
    yield* sql`INSERT INTO j5_playbook_checkpoint (request_id, run_id, owner_thread_id, step_id, step_title, summary, status, created_at)
      VALUES (${request.requestId}, ${request.runId}, ${request.ownerThreadId}, ${request.stepId}, ${request.stepTitle}, ${request.summary}, 'pending', ${request.createdAt})`;
    yield* sql`UPDATE j5_playbook_run SET checkpoint_request_id = ${request.requestId} WHERE run_id = ${request.runId}`;
  });
  const pendingRows = (reach: SessionReach, threadId?: ThreadId) => {
    const threadFilter =
      threadId === undefined ? sql`` : sql`AND checkpoint.owner_thread_id = ${threadId}`;
    const from = sql`FROM j5_playbook_checkpoint checkpoint
      JOIN j5_playbook_run run ON run.checkpoint_request_id = checkpoint.request_id
      WHERE run.status = 'active' AND checkpoint.status = 'pending' ${threadFilter}`;
    if (reach.kind === "service" || (reach.kind === "person" && reach.serverLevel !== null))
      return from;
    if (reach.kind !== "person" || reach.levels.length === 0) return sql`${from} AND 0`;
    const candidates = sql`SELECT thread.thread_id, thread.project_id
      FROM j5_playbook_checkpoint pending
      JOIN orchestration_v2_projection_threads thread ON thread.thread_id = pending.owner_thread_id
      WHERE pending.status = 'pending' AND thread.deleted_at IS NULL
        ${threadId === undefined ? sql`` : sql`AND pending.owner_thread_id = ${threadId}`}`;
    const visible = reachableThreadQuery(
      sql,
      reach.person.personId,
      reach.levels.some((level) => level.scope.kind === "thread"),
      candidates,
    );
    return sql`${from} AND checkpoint.owner_thread_id IN (${visible})`;
  };
  const pending = Effect.fn("PlaybookCheckpoints.pending")(function* (
    reach: SessionReach,
    threadId?: ThreadId,
  ) {
    const rows =
      yield* sql<Row>`SELECT checkpoint.* ${pendingRows(reach, threadId)} ORDER BY checkpoint.created_at`;
    return rows.map(present);
  });
  const count = Effect.fn("PlaybookCheckpoints.count")(function* (reach: SessionReach) {
    const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count ${pendingRows(reach)}`;
    return rows[0]!;
  });
  const answer = Effect.fn("PlaybookCheckpoints.answer")(function* (
    input: PlaybookCheckpointAnswer,
    timestamp: string,
  ) {
    const rows =
      yield* sql<Row>`UPDATE j5_playbook_checkpoint SET status = ${input.decision === "approve" ? "approved" : "declined"},
      answered_at = ${timestamp}, reason = ${input.reason?.trim() || null}
      WHERE request_id = ${input.requestId} AND owner_thread_id = ${input.threadId} AND status = 'pending'
        AND EXISTS (SELECT 1 FROM j5_playbook_run run JOIN orchestration_v2_projection_threads thread ON thread.thread_id = run.owner_thread_id
          WHERE run.checkpoint_request_id = ${input.requestId} AND run.status = 'active' AND thread.archived_at IS NULL AND thread.deleted_at IS NULL)
      RETURNING *`;
    if (!rows[0])
      return yield* playbookError(
        "already_answered",
        "This request was already answered or is no longer current.",
      );
    return present(rows[0]);
  });
  return { current, close, open, pending, count, answer };
};
