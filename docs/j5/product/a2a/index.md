---
title: "Agent-to-agent communication"
kind: definition
---

# Agent-to-agent communication

## Problem

Single agents can get more done than ever before, but there are still limits. Context spent on building pushes important conversation with the user out of the window. Independent reviewers bring a fresh perspective. Frontier models waste usage on simple tasks that could be completed by cheaper ones. There is great value in letting agents talk to one another and coordinate work.

However, this must be done at the platform level. LLMs are not reliable and have their limits:

- Many A2A communication systems rely on polling or outside event triggers. The platform knows what is happening and can ensure timely delivery.
- Agents fall over all the time, the platform can notify the calling agent or user when that happens.
- When a user spawns many agents, they won't always pay attention to them all. Having a way for the agent to get in touch with the user beyond a "done" or "question" notification is needed.

Agent-to-agent communication is J5's answer: a way for agents and people to talk to each other that is **durable** (nothing is lost when a process ends), **measured** (the platform records what actually happened rather than trusting what an agent says happened), and **legible** (a person can see who is waiting on whom, for what, and since when).

## Definition

Agent-to-agent communication has four layers. Each one exists to make a specific failure impossible to hide.

### Transport

J5 carries a message by using upstream's thread injection: the message becomes text in the receiver's conversation. Formatted with the right metadata so the agents and users can understand it.

### The ledger

Every Squadron has a **communication ledger**: an append-only record of everything that happens in communication — every message sent, every delivery outcome, every Exchange opened and closed, every silence notice, every participant joining or leaving.

The ledger is the source of truth. Nothing in it is ever edited or deleted, and every message in it is delivered. The ledger survives restarts, so a question asked before the server went down is still open when it comes back.

### The Exchange

An **Exchange** is one open question between two participants. It begins when one participant asks the other something, it stays open for as long as the other has not answered, and it ends with the answer. The platform tracks Exchanges so that _waiting_ is visible and attributable: at any moment the platform can say who owes whom an answer, about what, and for how long. This is the fact the inbox, the Fleet page and the silence notices are all built on.

An Exchange is never called a thread. A thread is a whole conversation; an Exchange is a single question that travels through conversations.

### Projections

A **projection** is a view the platform builds from the ledger — the inbox, the facts on the Fleet page, the communication graph, the playback of any earlier moment. Nothing is ever entered into a view directly. If a view is wrong, it is thrown away and rebuilt from the ledger, and it comes back the same. This is what lets the ledger be the only thing that needs to be trusted.

## How an Exchange works

There are three kinds of message.

- A **plain message** carries information and creates no obligation. Agents send these to each other freely.
- An **ask** opens an Exchange: the receiver now owes a reply. An ask carries a one-line **intent** that says what is being asked, so the question is legible wherever it is listed without opening the conversation. An ask to a person also carries an **urgency**, which says how soon the answer is needed.
- A **reply** names the Exchange it answers and closes it.

**Between agents**, one Exchange is open per pair of participants at a time. If the same agent asks the same peer again while the first question is still open, the second ask joins the open Exchange as a follow-up rather than opening a second one, so a chatty pair does not manufacture a pile of separate obligations. One reply closes the Exchange and everything that joined it.

**To a person**, an agent may hold several open asks at once, because distinct questions deserve distinct inbox items. A follow-up to a question the person has not yet answered is explicit: the agent names the Exchange it is following up on, and the follow-up joins that Exchange and is shown beneath the original ask, so the person always sees the whole question.

**Closing** is mechanical. An Exchange closes when the reply arrives, when the sender withdraws its own ask, or when the receiver is retired. Whether the reply was _complete_ is not the platform's judgment: a sender who is not satisfied opens a new Exchange about the earlier one, and the platform never decides that on its behalf.

## Participants

A participant is anything that can send and receive over the ledger: an agent with a Squadron home, or a person. People are global — one person id, known across every Squadron on the server — and nothing anywhere may assume there is exactly one of them. Provider-native Subagents are never participants.

Every participant can message every other participant. No Squadron, no placement in a tree and no Role restricts who may talk to whom; the hierarchy carries decisions, never messages, and a Captain commands its Crews by briefing them, never by routing their messages. An agent cannot message itself. The platform states identity facts wherever it speaks: the envelope names the sender, the address book marks the caller's own row, and a spawned agent's first turn tells it who it is.

## Delivery

Delivery is **log-first**: the ledger row is the act, and delivery is an attempt recorded against it. A successful attempt is a **delivery receipt**; a failed one is retried; a failure past the retry limit is a **delivery alarm** — a visible fact attributed to the sender, never a silent loss, and never assumed repaired because time passed or a later message got through. "Was it delivered" and "was it answered" are independent facts.

A message to an agent whose turn is running **queues** behind that turn and starts when it ends. **Steering** — injecting into the running turn — is a controller's act, and in J5 the only controller of an agent's turn is the person: they steer explicitly, and the control they use tells them what a steer does on that provider. There is one exception, ruled for one provider: a peer's update to an already-running Codex Astra turn is delivered into the turn, with guidance to keep the unfinished objective, because receiving information does not transfer control of the task. Platform notices always queue.

## The person as a participant

A person takes part in the same protocol as an agent, with two differences that follow from being a person.

Delivery is the **inbox**, not a conversation. An ask to a person lands in their inbox, gathered across every Squadron on the server. The person's answer, exactly as written, is the reply that closes the Exchange and reaches the asker — no relay, no summary. A person receives only asks and replies; a plain message to a person is refused, because a plain message carries nothing the sender's own thread does not already show, and if the person must see something then seeing it _is_ the obligation.

Silence is **never measured about a person**. A person has no turn that ends. How long their open asks have waited is a fact the inbox and the Fleet page show; nothing nags. When a person sends a message through the graph rather than the chat, its envelope says plainly that the person is not watching the agent's conversation and will see only what comes back on the Exchange.

## Silence

**Silence is measured; replies are asserted.** When an agent's turn ends without a reply it owed, the platform — never the agent — records a **silence notice**: the measured facts of what happened, not a conclusion about why. The facts are the turn that ended and how, whether the delivery was ever processed, every open outbound Exchange the agent holds, and any error or stop.

The platform names five kinds of silence: the turn ended without the owed reply; the turn errored; the agent was stopped, which tells the waiter not to retry; the agent is itself waiting on a person, and whether that person has seen the ask; and the agent is blocked on a peer, naming the peer. A notice informs the waiter. It never closes the Exchange, and it never claims to know whether the agent forgot or is waiting on something first — that is the waiter's judgment to make with the facts in hand.

## Envelopes

Every delivered message is wrapped in an **envelope**: the platform's wrapper that tells the receiving agent who sent this and from which Squadron, what it now owes and how to discharge it, and the measured time. Envelope wording is versioned configuration rendered from one place, so the channels never drift, and it is written in plain words for an agent reading it in the middle of its work. People reading the app see the letter, not the envelope.

## Vocabulary this definition owns

message, ask, reply, plain message, Exchange, intent, urgency, obligation, envelope, communication ledger, projection, delivery receipt, delivery alarm, silence notice, queue and steer. The [glossary](../glossary.md) points here for each of them. Provenance and placement are Squadron concepts and live in the [Squadron definition](../features/squadron.md).

## Acceptance criteria

### The ledger

1. Every message an agent or person sends through the platform is recorded in the sender's Squadron ledger before the sender's call returns.
2. Nothing in a ledger is ever edited or deleted, and every recorded message is delivered; a server restart loses nothing.
3. A message crossing Squadrons appears in both Squadrons' ledgers with a shared correlation id, and a crash between the two writes leaves the sender's row visible rather than losing the message.
4. Every projection can be rebuilt from the ledger to an identical result, and a mutated projection row fails the equivalence check.

### Exchanges

5. An ask opens an Exchange between its sender and receiver, carries a one-line intent, and carries an urgency when the receiver is a person.
6. While an Exchange is open between two agents, a further ask from the same sender to the same receiver joins it as a follow-up rather than opening a second Exchange.
7. An agent may hold several open Exchanges with the same person at once, each shown as its own inbox item.
8. A follow-up to an open ask to a person names the Exchange it follows up on, joins it, and is shown beneath the original ask in the inbox.
9. One reply naming the Exchange closes it, together with every follow-up that joined it; the sender may withdraw its own ask; the receiver's retirement closes it with a notice to the sender; nothing else closes it.
10. A message from an agent to itself is refused with an error naming the caller's own id.
11. No Squadron, placement, or Role restricts which participants may message each other.

### Delivery

12. Every delivery attempt is recorded; a delivery that fails past the retry limit is shown as an alarm attributed to the sender and is never marked repaired by time passing or by a different message succeeding.
13. A message to an agent whose turn is running is queued and delivered when the turn ends; no agent-originated delivery steers a running turn, except a peer update into a running Codex Astra turn, which is delivered into the turn with guidance to keep the unfinished objective.
14. Only a person can steer a running turn; the control they use names what a steer does on that provider, and when nothing is steerable it names the run's state and offers Interrupt instead.
15. Platform notices are always queued, never steered.

### The person

16. An agent-to-person send that is neither an ask nor a reply is refused with an error naming the two legal moves.
17. An ask to a person appears in that person's inbox regardless of which Squadron it came from.
18. A person's answer to an ask is delivered to the asker exactly as written, as the reply that closes the Exchange.
19. No silence notice is ever written about a person.

### Silence

20. When an agent's turn ends without a reply it owed, the platform records a silence notice holding the measured facts and delivers it to the waiter.
21. A silence notice never closes an Exchange.

### Envelopes

22. Every delivered message carries an envelope naming the sender, the sender's Squadron, what is owed, and the measured time.
23. A person's message sent through the graph carries an envelope saying the person is not watching the agent's conversation and will see only what returns on the Exchange.

## Scenarios

- **An ask and its answer.** An agent in Billing Migration asks its Captain "which schema version do we target?" with intent "schema target". The Captain's turn ends without replying; the platform records a silence notice and delivers it to the asker, whose next turn sees that the Captain's turn ended without replying. The Captain's next turn replies; the Exchange closes; the asker sees the answer. (AC5, AC9, AC20, AC21)
- **Two questions for the user.** The same agent asks the user "merge now or after the audit?" with urgency _soon_, and separately "may I delete the old branch?". Both appear as inbox items. The agent then learns something relevant to the first question and follows up on it by name; the follow-up appears under that item. The user answers each; each Exchange closes with the exact text delivered to the agent. (AC5, AC7, AC8, AC18)
- **A busy receiver.** An agent in Website Redesign sends a plain message to a peer whose turn is running a long shell command. The message queues; the peer's turn finishes normally; the message starts its next turn. The user, watching the peer, chooses to steer instead — the control says "Steer now" on this provider — and their text is injected into the running turn. (AC13, AC14)
- **A failed delivery.** An agent asks a peer that has been archived. The delivery fails, the alarm is attributed to the asker and shown on its Fleet page row; the asker withdraws its ask; the alarm remains a fact but no longer counts as a problem. (AC9, AC12)
- **Across Squadrons.** An agent in Billing Migration asks an agent in Support Rotation for an incident's status; both Squadrons' ledgers carry the Exchange under one correlation id; the Fleet page of either Squadron shows it as an open ask. (AC3)

## History

- 2026-08-14 — the communication graph drafted; former open questions 1–4 ([record](../../worklog/2026-08-14-communication-graph-draft.md)).
- 2026-08-16 — design settled; former D1–D10, this file's earlier form.
- 2026-08-21 — design review: former R3 (closure is mechanical, completeness is the sender's judgment), R4 (notices are measured facts; labels are read-time policy), R10 (a follow-up may name an earlier Exchange), R22 (Captains are never routers), R25 (time facts in envelopes) ([record](../design-review-2026-08-21.md)).
- 2026-08-24 — Subagent and Peer Agent distinguished; `delegate_task` excluded, so former D1's delegation edges no longer exist ([record](../../worklog/spawn-terminology-session-2026-08-24.md)).
- 2026-08-31 — self-send refused; identity facts stated by the platform ([record](../../worklog/picker-and-self-messaging-rulings-2026-08-31.md)).
- 2026-09-02 — a person receives only asks and replies ([record](../../worklog/human-addressed-sends-ruling-2026-09-02.md)).
- 2026-09-03 — agent deliveries queue; only the person steers; former QS1–QS4 ([record](../../worklog/queue-vs-steer-ruling-2026-09-03.md)).
- 2026-09-04 — the Codex Astra exception ([record](../../worklog/astra-peer-delivery-2026-09-04.md)).
- 2026-09-05 — rewritten into the definition shape; 2026-09-07 — provenance and placement moved to the Squadron definition (they are organization, not communication). One change of substance: an agent may hold several open asks to a person, with explicit follow-ups shown in the inbox — reversing the one-ask-per-person rule of 2026-09-02 (issue #111). Former identifiers: D1 → Participants (delegation half retired); D2 → Participants; D3, D8 → The ledger, AC3; D4 → AC5; D5 → Delivery, AC1; D6 → Silence, AC20; D7 → the A2A plan; D9 → The Exchange; D10 → the Squadron definition (placement and provenance), with its obligation half being the Exchange; R3 → How an Exchange works, AC9; R4 → Silence; R21 → the Squadron definition; R22 → Participants; R25 → Envelopes, AC22; QS1–QS4 → Delivery, AC13–AC15.
