import type { OrchestrationV2StoredEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The event upstream logs when a prompt is answered. Typed against upstream's own event union, so
 * a rename there fails to compile here.
 */
export const PROMPT_SETTLED_EVENT =
  "runtime-request.updated" satisfies OrchestrationV2StoredEvent["event"]["type"];

/**
 * Marks the person's answer whose command settled a prompt, in `j5_a2a_prompt_answer`, where it
 * outlives upstream's event pruning. Upstream re-accepts any command id it already took, so its
 * "accepted" is no proof; the settling event carries the command id. Idempotent; true when it
 * marked an answer.
 */
export const markPromptSettled = Effect.fn("j5.a2a.markPromptSettled")(function* (
  stored: OrchestrationV2StoredEvent,
) {
  const event = stored.event;
  if (event.type !== PROMPT_SETTLED_EVENT || stored.commandId === null) return false;
  const sql = yield* SqlClient.SqlClient;
  const marked = yield* sql`
    UPDATE j5_a2a_prompt_answer
    SET settled_at = ${DateTime.formatIso(event.occurredAt)}
    WHERE thread_id = ${event.threadId}
      AND request_id = ${event.payload.id}
      AND command_id = ${stored.commandId}
      AND settled_at IS NULL
    RETURNING thread_id
  `;
  return marked.length > 0;
});
