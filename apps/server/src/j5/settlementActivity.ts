import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * Which thread messages hold a thread open after its pull request merges or closes (register
 * D30, FORK.md case 62). Upstream counts only what a person wrote. J5 also counts what another participant sent through
 * a tool: an agent-to-agent delivery (local, machine or from a peer server), a spawn or seat
 * brief, and upstream's own agent sends (the continuation an agent queues for itself on a worktree
 * handoff is one). Those are stored as `createdBy: "agent"` with `creationSource: "mcp"`. Not
 * counted: the server's wakes on an agent's behalf (`createdBy: "agent"` with `"server"` or
 * `"provider"`), platform notices (`createdBy: "system"`), and an agent's scheduled task (it
 * carries `scheduledTaskId`). Whatever upstream stores as `createdBy: "user"` counts as upstream
 * has it, a person's schedule and the usage-limit resume included.
 */
export const isSettlementActivityMessage = (
  message: Pick<
    OrchestrationV2ConversationMessage,
    "role" | "createdBy" | "creationSource" | "scheduledTaskId"
  >,
): boolean =>
  message.role === "user" &&
  (message.createdBy === "user" ||
    (message.createdBy === "agent" &&
      message.creationSource === "mcp" &&
      message.scheduledTaskId === undefined));

/**
 * The same rule as a SQL condition on a row of `orchestration_v2_projection_messages` aliased
 * `message`. It holds no input, so the settlement candidate query includes it as a literal.
 */
export const SETTLEMENT_ACTIVITY_MESSAGE_SQL = `message.role = 'user' AND (
  json_extract(message.payload_json, '$.createdBy') = 'user'
  OR (
    json_extract(message.payload_json, '$.createdBy') = 'agent'
    AND json_extract(message.payload_json, '$.creationSource') = 'mcp'
    AND json_extract(message.payload_json, '$.scheduledTaskId') IS NULL
  )
)`;

/** The newest message that counts, for the settlement candidates the in-memory store builds. */
export const latestSettlementActivityMessageAt = (
  messages: ReadonlyArray<
    Pick<
      OrchestrationV2ConversationMessage,
      "role" | "createdBy" | "creationSource" | "scheduledTaskId" | "updatedAt"
    >
  >,
): DateTime.Utc | null =>
  messages
    .filter(isSettlementActivityMessage)
    .reduce<DateTime.Utc | null>(
      (latest, message) =>
        latest === null || DateTime.isGreaterThan(message.updatedAt, latest)
          ? message.updatedAt
          : latest,
      null,
    );
