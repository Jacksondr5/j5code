import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { getThreadRecordsIfPresent } from "../a2a/threadProjectionReads.ts";
import { PlaybookStore } from "./PlaybookStore.ts";

export const unnotifiedCheckpoints = (sql: SqlClient.SqlClient) => sql<{
  request_id: string;
  owner_thread_id: string;
  step_title: string;
  persona_picks: number;
  status: string;
  reason: string | null;
}>`
      SELECT checkpoint.request_id, checkpoint.owner_thread_id, checkpoint.step_title,
        checkpoint.status, checkpoint.reason, (checkpoint.persona_picks_json IS NOT NULL) AS persona_picks
      FROM j5_playbook_checkpoint checkpoint
      JOIN j5_playbook_run run ON run.run_id = checkpoint.run_id
      WHERE checkpoint.status IN ('approved', 'declined') AND checkpoint.notified_at IS NULL AND run.status = 'active'`;

export const makeCheckpointNotifications = Effect.gen(function* () {
  const store = yield* PlaybookStore;
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService;
  const drain = Effect.fn("CheckpointNotifications.drain")(function* () {
    const rows = yield* unnotifiedCheckpoints(sql);
    let failed = false;
    for (const row of rows) {
      yield* Effect.gen(function* () {
        const request = {
          requestId: row.request_id,
          ownerThreadId: ThreadId.make(row.owner_thread_id),
          stepTitle: row.step_title,
          status: row.status,
          reason: row.reason,
          personaPicks: Boolean(row.persona_picks),
        };
        const target = yield* getThreadRecordsIfPresent(threads, request.ownerThreadId, []);
        if (!target || target.thread.archivedAt !== null || target.thread.deletedAt !== null)
          return;
        yield* threads.dispatch({
          type: "message.dispatch",
          createdBy: "system",
          creationSource: "server",
          commandId: CommandId.make(`playbook-checkpoint:${request.requestId}`),
          messageId: MessageId.make(`playbook-checkpoint:${request.requestId}`),
          threadId: request.ownerThreadId,
          text: request.personaPicks
            ? `The run's persona picks were ${request.status}.${request.reason ? ` Reason: ${request.reason}` : ""} Retrieve j5_playbook_current before staffing the run.`
            : `Playbook checkpoint "${request.stepTitle}" was ${request.status}.${request.reason ? ` Reason: ${request.reason}` : ""} This decision applies to that submitted request. Retrieve j5_playbook_current before continuing; changed work may need fresh approval.`,
          attachments: [],
          modelSelection: target.thread.modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        yield* sql`UPDATE j5_playbook_checkpoint SET notified_at = answered_at WHERE request_id = ${request.requestId}`;
      }).pipe(
        Effect.catchCause((cause) => {
          failed = true;
          return Effect.logWarning("Playbook checkpoint notification remains pending", {
            requestId: row.request_id,
            cause,
          });
        }),
      );
    }
    return failed;
  });
  return { drain, changes: store.changes };
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const notifications = yield* makeCheckpointNotifications;
    // The initial revision also drains answers committed before a server restart.
    let retryPending = false;
    yield* notifications.changes.pipe(
      Stream.map(() => true),
      Stream.merge(Stream.tick("30 seconds").pipe(Stream.map(() => false))),
      Stream.runForEach((changed) =>
        Effect.gen(function* () {
          if (changed || retryPending) {
            retryPending = yield* notifications.drain().pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not read pending playbook notifications", {
                  cause,
                }).pipe(Effect.as(true)),
              ),
            );
          }
        }),
      ),
      Effect.forkScoped,
    );
  }),
);
