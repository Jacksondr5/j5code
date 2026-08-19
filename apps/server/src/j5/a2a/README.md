# J5 A2A runtime configuration

`envelopes.v1.json` is the human-owned wording source for every injected A2A envelope and the three MCP tool descriptions. Templates use literal `{{name}}` placeholders; `EnvelopeFormatter.ts` is the only renderer. Change wording in the JSON file, keep every referenced placeholder, and bump `version` when the rendered contract changes.

`delivery-config.v1.json` owns the retry backoff and alarm threshold. Attempts reuse one upstream command/message id pair derived from the durable ledger message id. Increasing an attempt never rotates those ids: a permanently rejected upstream receipt must become a visible alarm rather than risk a second injection.

Agent-side epic bootstrap is deliberately explicit through the authenticated `join_epic` MCP tool. `send_message` and `list_participants` never auto-join. With no membership, `join_epic` either creates the requested first epic or creates a deterministic per-thread default. Rejoining the same epic is idempotent. An explicit epic may replace only that auto-created default; the leave is recorded with `participant.left`, and `openExchangeWarnings` reports any open exchange ID and peer left in the default epic.

All other cross-epic reassignment is blocked. Human/UI epic creation, selection, and management belong wholly to the future item-4 epic-definition surface and are not part of A2. That work must choose and test an explicit disposition for existing deliveries and exchanges—for example, block, cancel by ledger event, or transfer by ledger event—before any human/UI reassignment ships. The chosen behavior must also reconcile with typed silence: `peer left epic` is a candidate reason, while explicit cancellation requires a ledger event.

For a cross-epic send, the receiver ledger's idempotent `message.received` records durable acceptance of the sender's act before transport is attempted. It does not claim successful thread injection: delivery success, retries, and the terminal alarm remain in the sender epic's delivery projection.

Byte-equivalent rebuilds for the A2 exchange and delivery projections are deferred to the measured-projections milestone (M5). A2 keeps those tables derivable from the communication ledger but does not expose their rebuild operation.
