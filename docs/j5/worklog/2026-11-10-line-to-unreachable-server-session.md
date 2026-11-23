---
title: "A line to a server that cannot be reached (2026-11-06 to 2026-11-16)"
kind: record
---

# A line to a server that cannot be reached (2026-11-06 to 2026-11-16)

Jackson chose how a server that nothing can reach takes part in upstream's linked environments. The outcome is written into [cross-device](../product/cross-device.md) (the section on a line, AC13, AC29–AC35 and a scenario), [divergence D46](../product/upstream.md) and the [thread rendering](../product/features/thread-a2a-rendering.md) notices. This record is the story. The build is tracked in issue #951.

## What prompted it

Upstream is building multiplayer features, and some depend on T3 Connect: guest links (hidden in J5, D40), mobile push and webhooks. Upstream's linked environments do not: one server calls the other's MCP server at any address that reaches it. But a link is a synchronous call, so it works only towards a machine the caller can reach.

The common real topology is an always-on work VM behind nginx and a laptop that reaches it through Zscaler Private Access, behind a firewall that drops every inbound connection. The laptop can link to the VM; the VM can never link to the laptop. Taking links as shipped would leave every feature built on them one-way there, a gap that depends on which device can reach which. Jackson ruled that out as a downgrade from peering, where poll mode makes everything J5 offers work both ways. Hiding the features would withhold upstream's work.

## Options considered

- **Adapt each upstream feature onto J5's peering.** A port of every multiplayer feature at every advance, growing.
- **Make T3 Connect work in the corporate network.** Upstream's hosted Connect allows one account per server and is upstream's infrastructure, so J5 would run its own (#725), operations work on the scale of v3. `cloudflared` also connects out on port 7844 rather than through the corporate network, and security teams commonly flag it.
- **Offer poll mode upstream.** Julius declined a poll mode for the first version of links (pingdotgg/t3code#16655), so it is not a give-back.
- **Hold upstream's tools on the polling rail.** Every held tool would need a pending variant on result types upstream owns, reads would need snapshots, and control calls such as interrupt would need to expire. The same tool would behave differently by direction.
- **A line the unreachable server holds (chosen).** The laptop keeps a connection open to the VM; the VM makes it available on its own loopback, which upstream's link accepts as an address. Upstream's link tools then work both ways and synchronously, with no edit to upstream for the route itself.

## Rulings

- **Security is not a blocker.** Jackson expects the corporate security team to accept it. Forgery is not a design consideration on J5's closed network (2026-11-07), so the line has no sign-in of its own; it is opened with the credential the poller already holds, which also says which server it carries.
- **A failure has its own code, not a check of the line.** An unanswered link call fails with `peer_unreachable` rather than upstream's generic code, so nothing reads the line's state to classify a failure.
- **A notice when the line is back, no automatic retry, and no "end your turn".** The agent decides what to do; if it chooses another route, it may, until evidence shows that behaviour is bad. Upstream's follower of a running remote delegate keeps retrying on its own, so the parent gets no notice; the code stays outside the four the follower treats as final.
- **No nginx changes.** The line is a WebSocket on a path the VM's J5 already serves, with keepalives on the web app's rhythm, which already survives ZPA and nginx all day. The line test Jackson had prepared (a private repository) was skipped; a 5 MB message from the laptop to the VM and reconnect time after sleep are measured in the build's live test.
- **The line is invisible to the person** (2026-11-16, aligning with the unified link flow, #1004): linking uses the line's address on its own, and choosing to poll is what linking offers when one server cannot reach the other, so the line needs no setup step.
- **Messages keep polling.** A sleeping laptop has no line, so poll mode's storage stays and the line carries link calls only.
- **Sequencing.** After the upstream v0.1.7 merge: this first, then the unified link flow (#1004), then the cross-machine Peer Agent and persona delegate (#956, #957), then Crews across machines (#953).

## Out of scope

Reaching the laptop from a phone or any other machine through the VM; two servers that neither can reach, which need a third reachable server; the link flow's screens, which belong to the unified link flow (#1004).
