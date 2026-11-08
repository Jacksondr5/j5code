/**
 * Messages that hold a thread open after its PR merges (register D30, FORK.md case 62), as SQL on
 * `orchestration_v2_projection_messages` aliased `message`: upstream's person-written messages plus
 * another participant's tool sends (`createdBy: "agent"`, `creationSource: "mcp"`), not wakes,
 * notices or scheduled tasks. It holds no input, so the candidate query includes it as a literal.
 */
export const SETTLEMENT_ACTIVITY_MESSAGE_SQL = `message.role = 'user' AND (
  json_extract(message.payload_json, '$.createdBy') = 'user'
  OR (
    json_extract(message.payload_json, '$.createdBy') = 'agent'
    AND json_extract(message.payload_json, '$.creationSource') = 'mcp'
    AND json_extract(message.payload_json, '$.scheduledTaskId') IS NULL
  )
)`;
