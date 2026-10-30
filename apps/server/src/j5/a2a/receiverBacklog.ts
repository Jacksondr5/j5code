import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { isActiveRun, latestActiveRun } from "../../orchestration-v2/ThreadManagementService.ts";
import {
  latestExecutedRun,
  latestRootProviderFailure,
} from "@t3tools/shared/orchestrationV2ThreadError";

import {
  peerSteeringRun,
  deliveryMessageId,
  idleQueueHold,
  isDeliveryMessageId,
  requestedSteeringRun,
} from "./DeliveryTransport.ts";
import {
  formatReceiverBacklogNotice,
  formatReceiverLimitNotice,
  formatReceiverQueueHeldNotice,
} from "./EnvelopeFormatter.ts";
import {
  LedgerMessageId,
  Participant,
  type ParticipantId,
  type SendDeliveryOutcome,
  type SendMode,
} from "./contracts.ts";

export type ReceiverBacklog =
  | {
      readonly type: "behind_turn";
      /** Messages that will each start their own turn once the receiver's current turn ends. */
      readonly waiting: number;
      /** How many of those the caller sent. */
      readonly fromCaller: number;
    }
  | {
      readonly type: "usage_limit";
      /** When upstream continues the receiver, or null when it waits for a person. */
      readonly resetAt: string | null;
    }
  /** Its queue is held, so the message runs only once a person resumes it. */
  | { readonly type: "queue_held" };

/** What the sender is told about a message to an agent on this server. */
export type ReceiverDelivery = {
  readonly outcome: Exclude<SendDeliveryOutcome, "waiting_for_recipient">;
  /** Why a queued message waits, when there is something to tell the sender. */
  readonly backlog?: ReceiverBacklog;
};

const decodeParticipant = Schema.decodeUnknownEffect(Schema.fromJsonString(Participant));

/**
 * What will become of a just-sent message to an agent on this server, by the rule the delivery
 * worker applies, so the sender need not wait for the worker: `steered` into the running turn a
 * Claude or GPT 6 receiver takes updates in, or one a sender-asked `steer` lands on; `starting`
 * for an idle receiver, a Crew seat that has not started, or a `restart`; `queued` behind a turn
 * or held queue, with a `backlog` saying why when it is something the sender can act on. A message
 * the worker already handed over reads from what it did: its own run, or a delivery with no run,
 * which is a steer. Undefined when nothing can be said: the receiver is not an agent on this
 * server, or the message has already run or will never run. Measured when called and never
 * stored, so it is advice to the sender, not a delivery fact. A failed read is logged and reads
 * as undefined: the message is already committed, and the send must not fail over advice.
 */
export const readReceiverDelivery = Effect.fn("j5.a2a.readReceiverDelivery")(
  function* (input: {
    readonly receiverId: ParticipantId;
    /** The sending thread; an outside agent has none, and counts no waiting messages of its own. */
    readonly callerThreadId?: ThreadId | undefined;
    readonly sentMessageId: LedgerMessageId;
    /** How the sender asked for the message to land; absent means `queue`. */
    readonly mode?: SendMode | undefined;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const orchestrator = yield* OrchestratorV2;
    const rows = yield* sql<{ readonly payload: string }>`
      SELECT payload FROM j5_a2a_membership
      WHERE participant_id = ${input.receiverId} AND archived_at IS NULL
      LIMIT 1
    `;
    if (rows[0] === undefined) return undefined;
    const participant = yield* decodeParticipant(rows[0].payload);
    if (participant.kind !== "agent") return undefined;

    // Committed deliveries the worker has not handed to this thread yet. Read before
    // the runs: the worker commits a run before it marks the delivery delivered, so
    // every message lands in at least one of the two reads. The drain index keeps this
    // to the small set of pending rows.
    const pendingRows = yield* sql<{ readonly message_id: string; readonly sender_id: string }>`
      SELECT message_id, sender_id FROM j5_a2a_delivery
      WHERE status IN ('pending', 'retry_scheduled')
        AND receiver_id = ${input.receiverId}
        AND receiver_environment_id IS NULL
    `;

    const target = yield* orchestrator.getThreadRecords(participant.threadId, [
      "runs",
      "providerTurns",
      "providerThreads",
      "providerSessions",
    ]);
    if (target.thread.archivedAt !== null) return undefined;

    const mode = input.mode ?? "queue";
    const runByMessage = new Map(target.runs.map((run) => [run.userMessageId, run]));
    const sentRun = runByMessage.get(deliveryMessageId(input.sentMessageId));
    const pending = pendingRows.filter(
      (row) => !runByMessage.has(deliveryMessageId(LedgerMessageId.make(row.message_id))),
    );
    if (sentRun !== undefined && sentRun.status !== "queued") {
      // The worker got there first: a turn already runs on it (a replay reports the current
      // state, not the first one). A steer by interrupt-restart shows the same way.
      return isActiveRun(sentRun)
        ? ({ outcome: mode === "steer" ? "steered" : "starting" } satisfies ReceiverDelivery)
        : undefined;
    }
    if (sentRun === undefined && !pending.some((row) => row.message_id === input.sentMessageId)) {
      // Not queued and not pending: a steer the worker has delivered into a running turn leaves
      // no run of its own; a cancelled or alarmed message is not going anywhere.
      const status = (yield* sql<{ readonly status: string }>`
        SELECT status FROM j5_a2a_delivery WHERE message_id = ${input.sentMessageId} LIMIT 1
      `)[0]?.status;
      return status === "delivered"
        ? ({ outcome: mode === "restart" ? "starting" : "steered" } satisfies ReceiverDelivery)
        : undefined;
    }

    if (latestActiveRun(target) === undefined) {
      // An idle receiver takes the message now, resuming a held queue first, unless it
      // stopped on a usage limit or its worktree setup failed (`idleQueueHold`).
      const latestRun = latestExecutedRun(target.runs);
      // Only a failed run's errors can name a usage limit.
      const { turnItems } =
        latestRun?.status !== "failed"
          ? { turnItems: [] }
          : yield* orchestrator.getThreadRecords(participant.threadId, ["turnItems"], {
              turnItemRunIds: [latestRun.id],
              turnItemTypes: ["error"],
            });
      const hold = idleQueueHold({ ...target, turnItems });
      if (hold?.type === "worktree_setup_failed")
        return { outcome: "queued", backlog: { type: "queue_held" } } satisfies ReceiverDelivery;
      if (hold?.type === "usage_limit") {
        // Upstream continues it at the reset only when its recovery is armed for this limit,
        // as the thread's usage-limit banner shows.
        const recovery = target.thread.limitRecovery;
        const resetAt = latestRootProviderFailure(hold.run, turnItems)?.resetAt;
        return {
          outcome: "queued",
          backlog: {
            type: "usage_limit",
            resetAt:
              recovery?.autoResume === true &&
              recovery.runId === hold.run.id &&
              recovery.resetAt === resetAt
                ? recovery.resetAt
                : null,
          },
        } satisfies ReceiverDelivery;
      }
      // Resuming a held queue starts its messages first and this one joins the back; the sender
      // needs no notice, it runs without a person.
      return target.runs.some((run) => run.status === "queued" && run.id !== sentRun?.id)
        ? ({ outcome: "queued" } satisfies ReceiverDelivery)
        : ({ outcome: "starting" } satisfies ReceiverDelivery);
    }
    // Not yet handed over, so a running Claude or GPT 6 turn, or the turn a steer or restart lands on,
    // will take it mid-turn. Once queued, it stays queued even if the receiver's turn later
    // becomes steerable.
    if (
      sentRun === undefined &&
      (mode === "queue"
        ? peerSteeringRun(target, "peer")
        : requestedSteeringRun(target, "peer", mode)) !== undefined
    )
      return { outcome: mode === "restart" ? "starting" : "steered" } satisfies ReceiverDelivery;
    // A held queue drains only when someone resumes the thread, not when its turn ends.
    if (target.runs.some((run) => run.status === "queued" && run.queueHeld === true))
      return { outcome: "queued", backlog: { type: "queue_held" } } satisfies ReceiverDelivery;
    const callerId = (yield* sql<{ readonly sender_id: string }>`
      SELECT sender_id FROM j5_a2a_delivery WHERE message_id = ${input.sentMessageId} LIMIT 1
    `)[0]?.sender_id;

    const queued = target.runs.filter(
      (run) => run.status === "queued" && isDeliveryMessageId(run.userMessageId),
    );
    const queuedMessages =
      queued.length === 0
        ? []
        : (yield* orchestrator.getThreadRecords(participant.threadId, ["messages"], {
            messageIds: queued.map((run) => run.userMessageId),
          })).messages;
    return {
      outcome: "queued",
      backlog: {
        type: "behind_turn",
        waiting: queued.length + pending.length,
        fromCaller:
          input.callerThreadId === undefined
            ? 0
            : queuedMessages.filter((message) => message.senderThreadId === input.callerThreadId)
                .length + pending.filter((row) => row.sender_id === callerId).length,
      },
    } satisfies ReceiverDelivery;
  },
  (effect, input) =>
    effect.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("J5 A2A receiver delivery read failed", {
          receiverId: input.receiverId,
          cause,
        }).pipe(Effect.as(undefined)),
      ),
    ),
);

/**
 * Adds what the sender should know to a send result: the predicted `deliveryOutcome`, and a
 * `deliveryNotice` when the message waits on something the sender can act on. An outside agent has
 * no thread to count waiting messages by, so it gets the outcome alone.
 */
export const withDeliveryOutcome = Effect.fn("j5.a2a.withDeliveryOutcome")(function* <
  R extends { readonly messageId: LedgerMessageId },
>(
  result: R,
  input: {
    readonly receiverId: ParticipantId;
    readonly callerThreadId?: ThreadId | undefined;
    readonly mode?: SendMode | undefined;
  },
) {
  const delivery = yield* readReceiverDelivery({ ...input, sentMessageId: result.messageId });
  if (delivery === undefined) return result;
  const { backlog } = delivery;
  const deliveryNotice =
    input.callerThreadId === undefined || backlog === undefined
      ? undefined
      : backlog.type === "behind_turn"
        ? formatReceiverBacklogNotice({
            receiverId: input.receiverId,
            waiting: backlog.waiting,
            fromYou: backlog.fromCaller,
          })
        : backlog.type === "usage_limit"
          ? formatReceiverLimitNotice({ receiverId: input.receiverId, resetAt: backlog.resetAt })
          : formatReceiverQueueHeldNotice({ receiverId: input.receiverId });
  return {
    ...result,
    deliveryOutcome: delivery.outcome,
    ...(deliveryNotice === undefined ? {} : { deliveryNotice }),
  };
});
