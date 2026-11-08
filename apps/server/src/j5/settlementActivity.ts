/**
 * Messages that hold a thread open after its PR merges or closes (register D30, FORK.md case 62),
 * as a SQL condition on a row of `orchestration_v2_projection_messages` aliased `message`.
 * Beyond upstream's person-written messages, J5 counts tool sends by another participant
 * (`createdBy: "agent"`, `creationSource: "mcp"`): A2A deliveries, briefs, upstream's agent sends.
 * Not server wakes, system notices, or an agent's scheduled task (`scheduledTaskId`).
 * It holds no input, so the settlement candidate query includes it as a literal.
 */
export const SETTLEMENT_ACTIVITY_MESSAGE_SQL = `message.role = 'user' AND (
  json_extract(message.payload_json, '$.createdBy') = 'user'
  OR (
    json_extract(message.payload_json, '$.createdBy') = 'agent'
    AND json_extract(message.payload_json, '$.creationSource') = 'mcp'
    AND json_extract(message.payload_json, '$.scheduledTaskId') IS NULL
  )
)`;
