import type {
  CommandId,
  OrchestrationV2Command,
  OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { isDeliveryMessageId, ledgerMessageIdOfDelivery } from "./DeliveryTransport.ts";
import { A2ALedger } from "./LedgerService.ts";
import { CommCommandId, LedgerProjectId, ParticipantId } from "./contracts.ts";

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A delivery's queued text cut at its envelope: everything up to and including the header line
 * that names `senderId`, the body, and the instruction after it. Every peer envelope is a one-line
 * header, a blank line, the body, a blank line and an instruction with no blank line in it
 * (`envelopes.v1.json`), and a shared conversation may put a note or a person's line above the
 * header. Undefined when the text no longer has that shape, as after a person rewrote the header.
 */
export const splitDeliveryEnvelope = (text: string, senderId: string) => {
  const header = new RegExp(`^\\[[^\\n]*${escapeRegExp(senderId)}[^\\n]*\\]\\n\\n`, "m").exec(text);
  if (header === null) return undefined;
  const bodyStart = header.index + header[0].length;
  const bodyEnd = text.lastIndexOf("\n\n");
  if (bodyEnd < bodyStart) return undefined;
  return {
    prefix: text.slice(0, bodyStart),
    body: text.slice(bodyStart, bodyEnd),
    suffix: text.slice(bodyEnd),
  };
};

/**
 * Names who issued a queued-message edit, by its orchestration command id, for
 * `recordQueuedEdit` to read once the edit is committed. A retry of the same command keeps the
 * first claim; a claim whose command upstream refuses is never read.
 */
export const claimQueuedEdit = Effect.fn("j5.a2a.queuedEdits.claim")(function* (input: {
  readonly commandId: CommandId;
  readonly editorId: ParticipantId;
}) {
  const sql = yield* SqlClient.SqlClient;
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  yield* sql`
    INSERT INTO j5_a2a_queued_edit_claim (command_id, editor_id, created_at)
    VALUES (${input.commandId}, ${input.editorId}, ${createdAt})
    ON CONFLICT (command_id) DO NOTHING
  `;
});

/**
 * Claims a person's edit of a queued J5 delivery for them. Any other queued message is not the
 * ledger's, and a run that is not queued in the thread is refused by upstream.
 */
export const claimPersonQueuedEdit = Effect.fn("j5.a2a.queuedEdits.claimPerson")(function* (
  command: Extract<OrchestrationV2Command, { readonly type: "queued-run.edit" }>,
  personId: ParticipantId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly message_id: string | null }>`
    SELECT json_extract(payload_json, '$.userMessageId') AS message_id
    FROM orchestration_v2_projection_runs
    WHERE run_id = ${command.runId} AND thread_id = ${command.threadId}
  `;
  const messageId = rows[0]?.message_id;
  if (messageId == null || !isDeliveryMessageId(messageId)) return;
  yield* claimQueuedEdit({ commandId: command.commandId, editorId: personId });
});

interface EditedDeliveryRow {
  readonly project_id: string;
  readonly receiver_id: string;
  readonly sender_id: string;
  readonly envelope_channel: string;
  readonly message_text: string;
}

/**
 * The ledger follows an edit to a queued J5 delivery, whoever made it: upstream's
 * `message.updated` for the delivery's message becomes a `message.edited` event carrying the new
 * body, from the editor its command claimed. Other updates to the message (its run starting, a
 * promotion) leave the body as it was and record nothing. Keyed by the stored event, so replaying
 * the event stream records each edit once.
 */
export const recordQueuedEdit = Effect.fn("j5.a2a.queuedEdits.record")(function* (
  stored: OrchestrationV2StoredEvent,
) {
  const event = stored.event;
  if (event.type !== "message.updated" || event.payload.role !== "user") return [];
  const messageId = ledgerMessageIdOfDelivery(event.payload.id);
  if (messageId === undefined) return [];
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<EditedDeliveryRow>`
    SELECT
      delivery.project_id,
      delivery.receiver_id,
      delivery.sender_id,
      delivery.envelope_channel,
      delivery.message_text
    FROM j5_a2a_delivery AS delivery
    JOIN j5_a2a_membership AS membership ON membership.participant_id = delivery.receiver_id
    WHERE delivery.message_id = ${messageId}
      AND membership.thread_id = ${event.threadId}
    LIMIT 2
  `;
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) return [];
  // A notice is queued as its own text; a peer envelope's body is what the ledger records.
  const body =
    row.envelope_channel === "peer"
      ? splitDeliveryEnvelope(event.payload.text, row.sender_id)?.body
      : undefined;
  const text = body === undefined || body.trim().length === 0 ? event.payload.text : body;
  if (text === row.message_text) return [];
  const claims =
    stored.commandId === null
      ? []
      : yield* sql<{ readonly editor_id: string }>`
          SELECT editor_id FROM j5_a2a_queued_edit_claim WHERE command_id = ${stored.commandId}
        `;
  const editorId = claims[0]?.editor_id;
  const editedAt = DateTime.formatIso(event.occurredAt);
  const result = yield* (yield* A2ALedger).appendEvents({
    commandId: CommCommandId.make(
      `command:j5:a2a:edited:${encodeURIComponent(messageId)}:${stored.sequence}`,
    ),
    projectId: LedgerProjectId.make(row.project_id),
    acceptedAt: editedAt,
    events: [
      {
        kind: "message.edited",
        sender: editorId === undefined ? null : ParticipantId.make(editorId),
        receiver: ParticipantId.make(row.receiver_id),
        exchangeId: null,
        correlationId: null,
        payload: { messageId, text },
        createdAt: editedAt,
      },
    ],
  });
  return result.committed ? result.events : [];
});
