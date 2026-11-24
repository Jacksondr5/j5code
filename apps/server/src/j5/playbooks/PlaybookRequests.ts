import { PLAYBOOK_EXCHANGE_PREFIX } from "@t3tools/contracts/j5";
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import {
  CommCommandId,
  CorrelationId,
  EVERYONE_HERE_PERSON_ID,
  ExchangeId,
  LedgerMessageId,
  LedgerProjectId,
  ParticipantId,
  type AppendCommEventsCommand,
  type StoredCommEvent,
} from "../a2a/contracts.ts";
import type { A2ALedgerTransactionWriterShape } from "../a2a/LedgerService.ts";
import { playbookError } from "./definition.ts";

export const playbookRequestId = (uuid: string) => `${PLAYBOOK_EXCHANGE_PREFIX}${uuid}`;

export const readPlaybookRequest = Effect.fn("readPlaybookRequest")(function* (
  sql: SqlClient.SqlClient,
  requestId: string,
) {
  const [row] = yield* sql<{
    status: string;
    created_at: string;
    updated_at: string;
    reply: string | null;
  }>`
    SELECT e.status, e.created_at, e.updated_at, d.message_text AS reply
    FROM j5_a2a_exchange e LEFT JOIN j5_a2a_delivery d ON d.project_id = e.project_id
      AND d.exchange_id = e.exchange_id AND d.exchange_role = 'reply' AND d.sender_id LIKE 'human:%'
    WHERE e.exchange_id = ${requestId}`;
  if (!row) return null;
  const status =
    row.status === "open"
      ? "pending"
      : row.reply === null
        ? "closed"
        : row.reply.trim().toLowerCase() === "approve"
          ? "approved"
          : "declined";
  return {
    status,
    reason:
      status === "declined" ? row.reply?.replace(/^Decline(?::\s*|$)/i, "").trim() || null : null,
    createdAt: row.created_at,
    answeredAt: status === "pending" ? null : row.updated_at,
  } as const;
});

class RequestEvents extends Context.Service<RequestEvents, Array<StoredCommEvent>>()(
  "t3/j5/playbooks/PlaybookRequests/RequestEvents",
) {}

export function makePlaybookRequests(
  sql: SqlClient.SqlClient,
  writer: A2ALedgerTransactionWriterShape,
  notify: Effect.Effect<void>,
) {
  // Acquire the ledger permit before BEGIN. Publish and wake delivery only after both the run
  // pointer and its exchange commit. Rolled-back events must never reach subscribers.
  const transaction = Effect.fn("PlaybookRequests.transaction")(function* <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) {
    const events: Array<StoredCommEvent> = [];
    const result = yield* writer.withPermit(
      sql.withTransaction(effect).pipe(Effect.provideService(RequestEvents, events)),
    );
    if (events.length > 0) {
      yield* writer.publishCommitted(events);
      yield* notify;
    }
    return result;
  });
  const append = Effect.fn(function* (command: AppendCommEventsCommand) {
    const events = yield* RequestEvents;
    const result = yield* writer.appendEventsInTransaction(command);
    if (result.committed) events.push(...result.events);
  });
  const open = Effect.fn(function* (input: {
    requestId: string;
    threadId: ThreadId;
    title: string;
    body: string;
    at: string;
  }) {
    const [owner] = yield* sql<{ project_id: string; participant_id: string }>`
      SELECT project_id, participant_id FROM j5_a2a_membership WHERE thread_id = ${input.threadId} AND archived_at IS NULL`;
    if (!owner)
      return yield* playbookError("operation_failed", "The owner's Inbox identity is unavailable.");
    const projectId = LedgerProjectId.make(owner.project_id);
    const base = {
      sender: ParticipantId.make(owner.participant_id),
      receiver: EVERYONE_HERE_PERSON_ID,
      exchangeId: ExchangeId.make(input.requestId),
      correlationId: CorrelationId.make(input.requestId),
      createdAt: input.at,
    };
    yield* append({
      projectId,
      commandId: CommCommandId.make(input.requestId),
      acceptedAt: input.at,
      events: [
        { ...base, kind: "exchange.opened", payload: { intent: input.title, urgency: "blocking" } },
        {
          ...base,
          kind: "message.sent",
          payload: {
            messageId: LedgerMessageId.make(`message:${input.requestId}`),
            text: `${input.body}\n\nChoose Approve or Decline. Your decision goes to the playbook owner.`,
            originProjectId: projectId,
            receiverProjectId: projectId,
            exchangeRole: "ask",
            envelopeChannel: "peer",
          },
        },
      ],
    });
  });
  const close = Effect.fn(function* (requestId: string, at: string) {
    const [row] = yield* sql<{ project_id: string; sender_id: string; receiver_id: string }>`
      SELECT project_id, sender_id, receiver_id FROM j5_a2a_exchange WHERE exchange_id = ${requestId} AND status = 'open'`;
    if (!row) return;
    yield* append({
      projectId: LedgerProjectId.make(row.project_id),
      commandId: CommCommandId.make(`withdraw:${requestId}`),
      acceptedAt: at,
      events: [
        {
          kind: "exchange.closed",
          createdAt: at,
          exchangeId: ExchangeId.make(requestId),
          sender: ParticipantId.make(row.sender_id),
          receiver: ParticipantId.make(row.receiver_id),
          correlationId: CorrelationId.make(requestId),
          payload: { closureKind: "sender-cleared" },
        },
      ],
    });
  });
  return { transaction, open, close };
}
