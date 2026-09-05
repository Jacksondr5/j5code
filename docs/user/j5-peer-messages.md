# Peer messages in J5

Astra agents using Codex can receive peer messages and replies during an active turn. An incoming update provides context for the ongoing task; it does not replace your instructions. The agent is told to incorporate relevant information and continue its unfinished work.

Other models receive peer messages after their current run ends. An idle agent starts work on an incoming message normally. Messages also wait when an Astra turn is not yet ready to receive input or is finishing up. Platform lifecycle and silence notices remain queued.

This applies to new deliveries. Messages already in the queue stay there unless you explicitly steer them. Your composer still queues by default, and explicit human steering remains available.

Delivery into an active turn does not guarantee the agent has read or acted on the update yet. If the turn ends just as delivery is attempted, the existing delivery retry and alarm behavior applies.
