---
title: "One link flow session (2026-11-09)"
kind: record
---

# One link flow session (2026-11-09)

Jackson and an agent (Claude Opus 5.5, then Claude Fable 5.2) decided that a person connects two servers one way, not two. The outcome is written into [cross-device](../product/cross-device.md) (Environment links, AC36–AC48 and four scenarios) and [divergence D47](../product/upstream.md). This record is the story. The build is tracked in issue #1004.

## What prompted it

The advance to upstream v0.1.7 brought linked environments, which let an agent act on another machine. J5 already had peering, which carries messages between servers. Settings showed both, side by side. A comparison of the two setups (#925) recommended keeping them apart and letting peering borrow three things from linking: a pasted pairing code, an agent's request card and mobile setup. Jackson was asked about the first, and asked to talk through the line between the two instead.

## What was found

- Starting a Peer Agent on another machine needs both: a Full access link and peering. They were set up in two places, with different directions, lifetimes and removals.
- Three cases looked like reasons to want one without the other, and each fits as a choice inside one setup: trust that goes one way (a level for each direction), talking without acting (a level that allows messages only), and a server that runs T3 Code and not J5 (actions only).
- Upstream's link has no check before it is saved; peering's check already tests which server can reach which.
- An expired link fails an agent's call with a message that says to link again, and the agent can raise the request card to renew it from the thread.
- The glossary already had "link" for what brings a person in (People and access). The definition calls this one an environment link, and the person still reads "link".

## Rulings

Jackson, 2026-11-09:

- **The line between peering and links is for the code.** "While the line has been drawn well for the separation of who owns the code for various features, that line shouldn't appear for users." A person gets one way to connect two servers, because with two "they won't know when they need either".
- **J5 takes over upstream's link UI** on web and desktop, to offer the one flow. Add environment stays upstream's, with the link flow offered when it finishes.
- **The flow is choose, check, then link.** A checklist when there are several servers to link with; levels chosen once for all of them, with an override for one; the checks for every pair run together.
- **Levels** are Messages only and upstream's five, and they start at Supervised, as upstream's link does. The picker says what Full access adds.
- **The Labs setting** is turned on by linking at a level that needs it, and the flow says so.
- **Renewing** is one step by the person, from the row or from an agent's card. J5 never renews a link on its own.
- **Removing** ends the whole link on both servers. Setting a direction to Messages only ends only that direction's actions.
- **The agent's card** keeps upstream's shape. Approving it sets up messages and the one direction the agent asked for.
- **No pasted pairing code** in the flow: a server is added to the client first.
- **Mobile is parked.** "Fitting this UX in there might just be too problematic. We can think about it, but I won't commit to doing it yet." Mobile keeps upstream's card and list, and the web row shows a link with its actions part alone.
- **The word is "link".** "Peer servers" leaves what a person reads; "peering" stays the name of the message path.
- **Sequence:** after the line to a server that cannot be reached (#951), before Peer Agents and persona delegates on another machine (#956, #957).

## Settled while writing the definition (2026-11-19)

Four points were left open on 2026-11-09. The definition answers them, for Jackson's read:

- **What the check offers when a server cannot be reached.** Nothing new to choose. The line (2026-11-16) comes with polling, so actions take the route messages take, and the check states the result for each direction.
- **Pairs that already exist.** A row is read from what the two servers hold. A pair that was peered, linked or both shows as it is, and nothing is migrated or made again.
- **The route for messages.** Unchanged: chosen by the check when the pair is linked, and changed only by removing the link and linking again.
- **The command line.** `j5 environment link` and `j5 a2a peer` stay as they are, for a pair no one client can manage. The first makes a link with its actions part alone; the second makes one with both directions at Messages only.

Jackson, on reading the definition the same day: adding actions to a pair that is already peered "should be a simple UX, not something that requires a repair". It is one step, raising a level on the pair's row.

## Related

#925, the comparison this replaced. #951, the line. #956 and #957, which need both parts of a link. #1097, linking from mobile.
