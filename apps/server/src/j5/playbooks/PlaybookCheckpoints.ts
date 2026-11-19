import { NoticeOrigin, encodeNoticeOrigin } from "./noticeOrigin.ts";
import { ThreadId } from "@t3tools/contracts";
import type { PlaybookCheckpoint, PlaybookCheckpointAnswer } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { decodePickScopes, encodePickScopes, type ApprovedPick } from "./personaPickApprovals.ts";
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
  persona_picks_json: string | null;
};
const present = (row: Row): PlaybookCheckpoint => ({
  ...(row.persona_picks_json === null ? {} : { kind: "persona_picks" as const }),
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
  const personaApproval = Effect.fn("PlaybookCheckpoints.personaApproval")(function* (
    runId: string,
  ) {
    const rows = yield* sql<Row>`SELECT * FROM j5_playbook_checkpoint
      WHERE run_id = ${runId} AND persona_picks_json IS NOT NULL AND status <> 'closed'`;
    return rows[0] ? present(rows[0]) : null;
  });
  const close = Effect.fn("PlaybookCheckpoints.close")(function* (
    runId: string,
    timestamp: string,
    closingRun = false,
  ) {
    yield* sql`UPDATE j5_playbook_checkpoint SET status = 'closed', answered_at = ${timestamp}
      WHERE run_id = ${runId} AND status = 'pending'
        AND (${closingRun} OR persona_picks_json IS NULL)`;
    yield* sql`UPDATE j5_playbook_run SET checkpoint_request_id = NULL WHERE run_id = ${runId}`;
  });
  const open = Effect.fn("PlaybookCheckpoints.open")(function* (
    request: PlaybookCheckpoint,
    picks?: Readonly<Record<string, ApprovedPick>>,
  ) {
    yield* sql`INSERT INTO j5_playbook_checkpoint (request_id, run_id, owner_thread_id, step_id, step_title, summary, status, created_at, persona_picks_json, playbook_origin_json)
      VALUES (${request.requestId}, ${request.runId}, ${request.ownerThreadId}, ${request.stepId}, ${request.stepTitle},
        ${request.summary}, 'pending', ${request.createdAt}, ${picks === undefined ? null : encodePickScopes(picks)}, ${encodeNoticeOrigin(yield* NoticeOrigin)})`;
    if (picks === undefined)
      yield* sql`UPDATE j5_playbook_run SET checkpoint_request_id = ${request.requestId} WHERE run_id = ${request.runId}`;
  });
  const replacePersonaApproval = Effect.fn("PlaybookCheckpoints.replacePersonaApproval")(function* (
    request: PlaybookCheckpoint,
    picks: Readonly<Record<string, ApprovedPick>>,
    statuses: ReadonlyArray<{ persona: string; limits?: string | null }>,
    retryStepId?: string,
  ) {
    const [current] =
      yield* sql<Row>`SELECT * FROM j5_playbook_checkpoint WHERE run_id = ${request.runId}
      AND persona_picks_json IS NOT NULL AND status <> 'closed'`;
    if (!current && retryStepId === undefined && Object.keys(picks).length === 0) return;
    const previous = current?.persona_picks_json
      ? yield* decodePickScopes(current.persona_picks_json)
      : {};
    const spent = yield* sql<{ step_id: string; persona_id: string }>`SELECT step_id, persona_id
      FROM j5_playbook_staffing_launch WHERE run_id = ${request.runId}`;
    const wasSpent = (persona: string, stepId: string) =>
      spent.some((row) => row.persona_id === persona && row.step_id === stepId);
    if (
      retryStepId !== undefined &&
      !Object.entries(picks).some(
        ([persona, scope]) => scope.stepIds.includes(retryStepId) && wasSpent(persona, retryStepId),
      )
    )
      return yield* playbookError(
        "invalid_staffing_retry",
        "Choose a required, limited step whose staffing launch was already used.",
      );

    // Keep equivalent pending/approved requests and their outstanding launch tokens.
    const available = (scopes: Readonly<Record<string, ApprovedPick>>, requested?: string) => {
      const result: Record<string, ApprovedPick> = Object.create(null);
      for (const [persona, scope] of Object.entries(scopes)) {
        const pendingRetry =
          current?.status === "pending" ? previous[persona]?.retryStepId : undefined;
        const retry = requested ?? pendingRetry;
        const stepIds = scope.stepIds.filter((id) => id === retry || !wasSpent(persona, id));
        if (!stepIds.length) continue;
        const { retryStepId: _priorRetry, ...route } = scope;
        result[persona] = {
          ...route,
          stepIds,
          ...(retry && stepIds.includes(retry) ? { retryStepId: retry } : {}),
        };
      }
      return result;
    };
    const remaining = available(picks, retryStepId);
    if (
      current &&
      current.status !== "pending" &&
      retryStepId === undefined &&
      encodePickScopes(available(previous)) === encodePickScopes(remaining)
    )
      return;
    if (current?.status === "pending" && current.persona_picks_json === encodePickScopes(remaining))
      return;
    if (current)
      yield* sql`UPDATE j5_playbook_checkpoint SET status = 'closed', answered_at = COALESCE(answered_at, ${request.createdAt})
      WHERE request_id = ${current.request_id}`;
    if (Object.keys(remaining).length === 0) return;
    const lines = Object.entries(remaining).map(([persona, scope]) => {
      const limits = statuses.find((entry) => entry.persona === persona)?.limits;
      const renewal = scope.retryStepId ? ` (another launch for ${scope.retryStepId})` : "";
      return `• ${persona} for ${scope.stepIds.join(", ")}${renewal}: ${limits}`;
    });
    yield* open({ ...request, summary: [request.summary, ...lines].join("\n") }, remaining);
  });
  const pendingRows = (reach: SessionReach, threadId?: ThreadId) => {
    const threadFilter =
      threadId === undefined ? sql`` : sql`AND checkpoint.owner_thread_id = ${threadId}`;
    const from = sql`FROM j5_playbook_checkpoint checkpoint
      JOIN j5_playbook_run run ON run.run_id = checkpoint.run_id
        AND (checkpoint.persona_picks_json IS NOT NULL OR run.checkpoint_request_id = checkpoint.request_id)
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
    canAnswerPersonaPicks: boolean,
  ) {
    const rows =
      yield* sql<Row>`UPDATE j5_playbook_checkpoint SET status = ${input.decision === "approve" ? "approved" : "declined"},
      answered_at = ${timestamp}, reason = ${input.reason?.trim() || null}
      WHERE request_id = ${input.requestId} AND owner_thread_id = ${input.threadId} AND status = 'pending'
        AND (${canAnswerPersonaPicks} OR persona_picks_json IS NULL)
        AND EXISTS (SELECT 1 FROM j5_playbook_run run JOIN orchestration_v2_projection_threads thread ON thread.thread_id = run.owner_thread_id
          WHERE run.run_id = j5_playbook_checkpoint.run_id
            AND (j5_playbook_checkpoint.persona_picks_json IS NOT NULL OR run.checkpoint_request_id = ${input.requestId}) AND run.status = 'active' AND thread.archived_at IS NULL AND thread.deleted_at IS NULL)
      RETURNING *`;
    if (!rows[0] && !canAnswerPersonaPicks) {
      const restricted = yield* sql`SELECT request_id FROM j5_playbook_checkpoint
        WHERE request_id = ${input.requestId} AND owner_thread_id = ${input.threadId}
          AND persona_picks_json IS NOT NULL AND status <> 'closed'`;
      if (restricted.length > 0)
        return yield* playbookError(
          "capability_denied",
          "Only a server Owner can answer playbook persona picks.",
        );
    }
    if (!rows[0])
      return yield* playbookError(
        "already_answered",
        "This request was already answered or is no longer current.",
      );
    if (input.decision === "approve" && rows[0].persona_picks_json !== null) {
      // Only the first authenticated approval can release the previous reservation.
      // Older tokens belong to closed requests and cannot spend it again.
      yield* sql`DELETE FROM j5_playbook_staffing_launch WHERE run_id = ${rows[0].run_id}
        AND EXISTS (SELECT 1 FROM json_each(${rows[0].persona_picks_json}) pick
          WHERE pick.key = persona_id AND json_extract(pick.value, '$.retryStepId') = step_id)`;
    }
    return present(rows[0]);
  });
  return { current, personaApproval, replacePersonaApproval, close, open, pending, count, answer };
};
