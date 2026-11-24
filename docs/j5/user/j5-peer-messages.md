# Peer messages in J5

An agent whose provider can take messages mid-turn receives peer messages and replies during an active turn: Codex, Claude, Cursor, OpenCode, Grok, Kiro, and Antigravity 1.5 and later. A Claude agent reads a message once the tool calls it's running finish, without cancelling them; a Cursor agent may cancel tool calls in flight. An incoming update provides context for the ongoing task; it does not replace your instructions. The agent is told to incorporate relevant information and continue its unfinished work.

Other agents receive peer messages after their current run ends. An idle agent starts work on an incoming message normally. Messages also wait when a turn is not yet ready to receive input or is finishing up, when anything is already queued for the agent, and when the sender asked for `queue`. Platform lifecycle and silence notices remain queued.

This applies to new deliveries. Messages already in the queue stay there unless you explicitly steer them. Whether your own send steers the active turn or queues behind it follows the **Follow-up behavior** setting; the opposite action has its own shortcut (see [Composer](../../user/composer.md)).

J5 records active-turn delivery after the provider accepts the steering input. Delivery into an active turn does not guarantee the agent has read or acted on the update yet. If the turn ends just as delivery is attempted, or the provider does not acknowledge within 30 seconds, the existing delivery retry and alarm behavior applies. A delayed acknowledgment may still arrive; retries check the original delivery rather than send a new copy.
