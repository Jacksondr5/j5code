---
title: "Peering poll mode session (2026-10-02)"
kind: record
---

# Peering poll mode session (2026-10-02)

Jackson reviewed and approved a design for peering a server that cannot be reached. The outcome is written into [cross-device](../product/cross-device.md) (the Peering section, AC11–AC19, AC22, AC24 and AC25), the [A2A definition](../product/a2a/index.md) and the [agent tools](../product/a2a/agent-tools.md). This record is the story. The build is tracked in issue #399.

## What prompted it

The common real topology is a work VM that is always up and reachable, and a laptop behind a corporate firewall that drops every inbound connection. The laptop can open HTTPS to the VM through the office proxy; the VM can never open anything to the laptop. Peering as defined on 2026-09-16 assumed each server could reach the other, so in that topology:

- peering could not be set up, because a server recorded a peer only after reaching it at its origin;
- had it been set up, the VM's deliveries would have alarmed within about a second and never been retried (#260);
- the VM could not list the laptop's agents, because the address book read every peer's roster live;
- a refused or alarmed delivery was recorded on the server but never told to the sending agent, which poll mode would make common.

## Rulings

- **Vocabulary.** "Send directly" and "poll", in the UI and the code alike. Link modes are `push`, `store` (the reachable server's record of a poller) and `poll` (the poller's record). Earlier drafts' "collect", "keeps" and "outbox" are retired; "held" stays the delivery worker's word for a paused receiver.
- **Pairing.** A poll pairing needs one credential, because only one side connects. The storing server records its poller when the poller first presents that credential; that proof stands in for reaching it at an origin.
- **The dialog sets it up.** The client checks reachability in each direction and each server's run mode (desktop app, system service, or started by hand), states how messages will travel, and asks only what the check could not settle. A server that may be off when a message arrives gets a question, with polling as the default. Machine kind is not used. A server too old to poll gets only "update J5 on it" and Close. Jackson approved the app mockup.
- **Agents see where participants live.** This reverses "peering is invisible to agents" from 2026-09-16. People give their servers different capabilities, such as Xcode on a laptop or a database connection on a VM, and an agent can pick the right participant once it sees where each lives. Agents still address by id; no tool takes, chooses or manages a server, and advertising capabilities is the person's job.
- **Server names.** A server's name is upstream's label for it, one per server. The per-pair "known on the other server as" labels go. Renaming a server means renaming its machine; a machine that cannot be renamed is explained in the person's own agent instructions.
- **Removal wipes the slate**, in every mode: waiting messages are cancelled with a notice to each sender, open Exchanges drop (#286), and peering again starts empty. Changing a pair's mode means removing it and peering again.
- **Sender feedback.** Sends and the address book report an offline peer server and when it was last available; refused and cancelled deliveries reach the sender as not-delivered notices; a refused ask ends its Exchange.
- **Versions.** Upstream's two tiers: a descriptor capability flag between client and server, and a peer protocol version plus capabilities between servers. The version rides on every peer request and response and both sides check it, so a mismatch is caught whichever server was updated (the Captain's ruling in the build, refining the approved plan).

## Out of scope

Relay, tunnel and client forwarding; automatic mode switching; a capability registry; a rename setting; restoring anything on re-peering; a dialog fallback for an older server; the mobile client; and the alarm surface for direct sends (#260).
