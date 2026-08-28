# J5 A2A runtime configuration

`envelopes.v1.json` is the human-owned wording source for every injected A2A envelope and the two MCP tool descriptions. Templates use literal `{{name}}` placeholders; `EnvelopeFormatter.ts` is the only renderer. Change wording in the JSON file, keep every referenced placeholder, and bump `version` when the rendered contract changes.

`delivery-config.v1.json` owns the retry backoff and alarm threshold. Attempts reuse one upstream command/message id pair derived from the durable ledger message id. Increasing an attempt never rotates those ids: a permanently rejected upstream receipt must become a visible alarm rather than risk a second injection.

Production includes a non-agent-invocable home registrar for sanctioned creation paths. `registerAtCreation` accepts only an explicit existing squadron, records one immutable `participant.joined`, replays the same creation without another event, and rejects a different requested home. `getHomeForThread` reads historical join events so later lifecycle retirement cannot erase or reassign a thread's home. The registrar never creates, selects, moves, or leaves squadrons, and it is not an agent tool.

The J5 `spawn_agent` wrapper is the production registrar consumer. It requires an already-registered current caller, passes the required idempotent delegation request to upstream unchanged, then registers the returned child in the caller's immutable home Squadron and records `j5_wrapper` spawned-by provenance with placement under that caller. It exposes no Squadron or placement selection. Retries reuse the upstream child, registrar command, and placement command; a missing Squadron is refused before delegation.

No native user-created-thread hook consumes the registrar. Such threads remain explicit nonparticipants: `send_message` and `list_participants` fail closed when the caller has no home. There is no default Squadron, agent-created home, move action, or production seeding helper. The human-run [live proof](../../../../../docs/j5/a2a-live-proof.md) uses a controlled seed only for its isolated Codex parent, then proves that the real wrapper registers and places the Claude child before messaging begins.

For a cross-squadron send, the receiver ledger's idempotent `message.received` records durable acceptance of the sender's act before transport is attempted. It does not claim successful thread injection: delivery success, retries, and the terminal alarm remain in the sender squadron's delivery projection.

Byte-equivalent rebuilds for the A2 exchange and delivery projections are deferred to the measured-projections milestone (M5). A2 keeps those tables derivable from the communication ledger but does not expose their rebuild operation.

A3 requires every sent-message event and delivery row to declare an explicit envelope channel. Peer sends write `peer`; silence notices write `silence_notice`, reuse A2's versioned silence-notice formatter, and bypass peer/human wrapping in the shared transport.

The silence detector checkpoints its global v2 event sequence in the J5 migration lane. A new installation first reconciles only open delivered exchanges against current thread projections, records the existing v2 high-water mark, and then tails from that durable cursor; retries replay at most the uncheckpointed tail instead of scanning the event store from genesis on every boot. A broken v2 subscription uses capped exponential backoff without re-running the reconciliation scan on every attempt.
