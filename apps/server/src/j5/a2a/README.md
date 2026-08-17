# J5 A2A runtime configuration

`envelopes.v1.json` is the human-owned wording source for every injected A2A envelope and the three MCP tool descriptions. Templates use literal `{{name}}` placeholders; `EnvelopeFormatter.ts` is the only renderer. Change wording in the JSON file, keep every referenced placeholder, and bump `version` when the rendered contract changes.

`delivery-config.v1.json` owns the retry backoff and alarm threshold. Attempts reuse one upstream command/message id pair derived from the durable ledger message id. Increasing an attempt never rotates those ids: a permanently rejected upstream receipt must become a visible alarm rather than risk a second injection.

Agent-side epic bootstrap is deliberately explicit through the authenticated `join_epic` MCP tool. `send_message` and `list_participants` never auto-join. Human/UI epic creation, selection, and management belong to the item-4 surface milestone and are not part of A2.

An explicit `join_epic` reassignment takes effect immediately: it does not transfer or cancel pending deliveries and open exchanges in the previous epic. The response warns with each open exchange ID and peer in the epics being left. A delivery whose recipient has left follows the normal retry-to-alarm path, while an open exchange remains durable in its original ledger. Before item 4 exposes human-managed reassignment, it must define and test an explicit disposition (for example, block, cancel by ledger event, or transfer by ledger event) instead of silently reusing this bootstrap behavior. That choice must also reconcile with typed silence: `peer left epic` is a candidate reason, while explicit cancellation requires a ledger event.

For a cross-epic send, the receiver ledger's idempotent `message.received` records durable acceptance of the sender's act before transport is attempted. It does not claim successful thread injection: delivery success, retries, and the terminal alarm remain in the sender epic's delivery projection.

Byte-equivalent rebuilds for the A2 exchange and delivery projections are deferred to the measured-projections milestone (M5). A2 keeps those tables derivable from the communication ledger but does not expose their rebuild operation.
