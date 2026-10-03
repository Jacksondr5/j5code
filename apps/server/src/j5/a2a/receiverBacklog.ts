import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { latestActiveRun } from "../../orchestration-v2/ThreadManagementService.ts";
import {
  astraPeerSteeringRun,
  deliveryMessageId,
  isDeliveryMessageId,
} from "./DeliveryTransport.ts";
import { formatReceiverBacklogNotice } from "./EnvelopeFormatter.ts";
import { Participant, type LedgerMessageId, type ParticipantId } from "./contracts.ts";

export interface ReceiverBacklog {
  /** Messages that will each start their own turn once the receiver's current turn ends. */
  readonly waiting: number;
  /** How many of those the caller sent. */
  readonly fromCaller: number;
}

const decodeParticipant = Schema.decodeUnknownEffect(Schema.fromJsonString(Participant));

/**
 * What a just-sent message is waiting behind: the receiver's running turn and the
 * A2A messages already queued after it. Undefined when the message will not wait:
 * the receiver is idle, takes peer messages mid-turn (Astra), or is not an agent
 * on this server. Measured when called and never stored, so it is advice to the
 * sender, not a delivery fact. A failed read is logged and reads as undefined:
 * the message is already committed, and the send must not fail over advice.
 */
export const readReceiverBacklog = Effect.fn("j5.a2a.readReceiverBacklog")(
  function* (input: {
    readonly receiverId: ParticipantId;
    readonly callerThreadId: ThreadId;
    readonly sentMessageId: LedgerMessageId;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const orchestrator = yield* OrchestratorV2;
    const rows = yield* sql<{ readonly payload: string }>`
      SELECT payload FROM j5_a2a_squadron_membership
      WHERE participant_id = ${input.receiverId} AND archived_at IS NULL
      LIMIT 1
    `;
    if (rows[0] === undefined) return undefined;
    const participant = yield* decodeParticipant(rows[0].payload);
    if (participant.kind !== "agent") return undefined;

    const target = yield* orchestrator.getThreadRecords(participant.threadId, [
      "runs",
      "providerTurns",
      "providerThreads",
      "providerSessions",
    ]);
    if (target.thread.archivedAt !== null) return undefined;
    const sent = deliveryMessageId(input.sentMessageId);
    if (latestActiveRun(target) === undefined) return undefined;
    // This message already started a run (the receiver was idle) or has run since;
    // a replayed send reports the current state, not the state when it was first sent.
    if (target.runs.some((run) => run.userMessageId === sent && run.status !== "queued"))
      return undefined;
    if (astraPeerSteeringRun(target, "peer") !== undefined) return undefined;
    // A held queue drains only when someone resumes the thread, so "after its current
    // turn ends" would be false. Telling the sender about held receivers is #272.
    if (target.runs.some((run) => run.status === "queued" && run.queueHeld === true))
      return undefined;

    const queued = target.runs.filter(
      (run) => run.status === "queued" && isDeliveryMessageId(run.userMessageId),
    );
    const queuedMessages =
      queued.length === 0
        ? []
        : (yield* orchestrator.getThreadRecords(participant.threadId, ["messages"], {
            messageIds: queued.map((run) => run.userMessageId),
          })).messages;
    const fromCaller = queuedMessages.filter(
      (message) => message.senderThreadId === input.callerThreadId,
    ).length;
    // The delivery worker may not have queued this message yet; it will wait all the same.
    const sentQueued = queued.some((run) => run.userMessageId === sent);
    return sentQueued
      ? ({ waiting: queued.length, fromCaller } satisfies ReceiverBacklog)
      : ({ waiting: queued.length + 1, fromCaller: fromCaller + 1 } satisfies ReceiverBacklog);
  },
  (effect, input) =>
    effect.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("J5 A2A receiver backlog read failed", {
          receiverId: input.receiverId,
          cause,
        }).pipe(Effect.as(undefined)),
      ),
    ),
);

/** Adds the backlog notice to a send result when the message will wait behind the receiver's turn. */
export const withDeliveryNotice = Effect.fn("j5.a2a.withDeliveryNotice")(function* <
  R extends { readonly messageId: LedgerMessageId },
>(result: R, input: { readonly receiverId: ParticipantId; readonly callerThreadId: ThreadId }) {
  const backlog = yield* readReceiverBacklog({ ...input, sentMessageId: result.messageId });
  return backlog === undefined
    ? result
    : {
        ...result,
        deliveryNotice: formatReceiverBacklogNotice({
          receiverId: input.receiverId,
          waiting: backlog.waiting,
          fromYou: backlog.fromCaller,
        }),
      };
});
