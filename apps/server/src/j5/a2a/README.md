# J5 A2A runtime configuration

`envelopes.v1.json` is the human-owned wording source for every injected A2A envelope and the two MCP tool descriptions. Templates use literal `{{name}}` placeholders; `EnvelopeFormatter.ts` is the only renderer. Change wording in the JSON file, keep every referenced placeholder, and bump `version` when the rendered contract changes.

`delivery-config.v1.json` owns the retry backoff and alarm threshold. Attempts reuse one upstream command/message id pair derived from the durable ledger message id. Increasing an attempt never rotates those ids: a permanently rejected upstream receipt must become a visible alarm rather than risk a second injection.

Production membership provisioning is intentionally absent from A2. Native threads without an internally registered home squadron are not A2A participants. The authenticated MCP toolkit exposes only `send_message` and `list_participants`; both fail closed when the caller has no provisioned squadron membership. It does not expose an agent-invocable join, default squadron creation, or squadron movement. The membership schema, projection, and lifecycle events remain as the durable foundation for provisioning outside the agent tool surface.

The named coordinated **home-squadron registrar + A6 creation integrations** follow-up owns internal creation-time registration and its product integrations: users create and choose squadrons, and a spawned agent inherits its spawner's home squadron. That follow-up also owns the executable live-proof runbook and a fresh real Codex-to-Claude proof before A3 is staffed. This PR does not infer those creation-time seams early or advertise a tool that production cannot provision truthfully.

For a cross-squadron send, the receiver ledger's idempotent `message.received` records durable acceptance of the sender's act before transport is attempted. It does not claim successful thread injection: delivery success, retries, and the terminal alarm remain in the sender squadron's delivery projection.

Byte-equivalent rebuilds for the A2 exchange and delivery projections are deferred to the measured-projections milestone (M5). A2 keeps those tables derivable from the communication ledger but does not expose their rebuild operation.

A3 persists an explicit delivery envelope channel. Existing delivery rows are backfilled as `peer`, which is the only path that existed before A3; current sends also write `peer` explicitly. Silence notices write `silence_notice`, reuse A2's versioned silence-notice formatter, and bypass peer/human wrapping in the shared transport.
