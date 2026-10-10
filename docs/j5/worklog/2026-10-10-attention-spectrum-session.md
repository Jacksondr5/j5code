---
title: "Attention spectrum session (2026-10-10)"
kind: record
---

# Attention spectrum session (2026-10-10)

Jackson and an agent worked on what the human-contact spectrum means for the product. The spectrum is a lens in the [principles](../product/principles.md); the session's subject was what it looks like in the interface. This record holds the rulings. They are proposals until the principles and the feature definitions carry them. The session covered one person on one server; several people were set aside.

## What prompted it

The principles describe a spectrum from Foreground agents, which talk with the person in chat often, to Background agents, which reach the person only through the inbox or a Captain. Nothing in the product knows where an agent sits. Jackson's thinking on the principle had changed, and he restated it.

## Rulings: the principle

Jackson's restatement:

- **Every agent is on the spectrum.** It describes how a person interacts with agents, so no agent is outside it.
- **An agent moves along it during its life**, sometimes because the person chose, sometimes in response to an event.
- **The platform makes intelligent choices about where an agent belongs, and gives the person controls.**

Agreed in the session:

- **An agent's place is not a value the platform computes.** It is the result of things that already exist: where the agent sits in the lineage, whether it is settled, snoozed or pinned, whether it is a Crew seat. The spectrum is how those are read. An earlier proposal in the session, to measure a position from how often the person talks to an agent, was dropped.
- **The platform's choices are rule-based, visible and reversible.** Upstream's auto-settle is the model: a stated rule acting on a measured fact, with a result the person can see and undo, and a switch to turn it off. "Intelligent" never means the interface guessing what the person cares about.
- **J5's surfaces mark; they do not move.** When something happens to an agent, its row keeps its place and gains a mark. A list that rearranges while it is read costs the reader their place, and on the Fleet page a row's position says who is running what. Upstream's sidebar sorts by recency and is left as it is.

## Rulings: the bands

The spectrum has three bands, told apart by what reaches the person from the agent.

| Band       | What the person takes in                       | Home                                 |
| ---------- | ---------------------------------------------- | ------------------------------------ |
| Foreground | The agent's words: the conversation is read    | The sidebar and the open thread      |
| Middle     | The agent's signals: facts about it            | The Fleet page's Active table        |
| Background | Nothing, until it reaches out or is looked for | Settled, and tucked into the lineage |

What already moves an agent, as Jackson listed it:

- **Upstream.** Subagents live in the lineage and stay out of the sidebar, and can be opened from there. Settling moves an agent to the background and leaves it retrievable, and auto-settle does that for an agent that is very likely done. Snooze moves an agent out of the way for a set time.
- **J5.** A Crew sits under its Captain, so many agents take little attention. A Playbook gives a signal about an agent without its thread being read. The Fleet page shows facts about agents at a glance.

- **The middle is where J5 adds what upstream lacks.** Upstream has many tools for managing foreground agents and places for background agents to live, and no feature for an agent the person does not want to talk to and still wants a signal from: which Playbook step it is on, how many Exchanges it has open, whether it died.
- **J5 also helps the agent.** It can tell an agent where it sits on the spectrum and manage the tools it has accordingly.

## Rulings: snooze, and what comes first

- **Snooze is not the way into the middle.** The agent proposed reading a snoozed agent as a middle agent, since it leaves the sidebar and stays a row on the Fleet page. Jackson: snooze is upstream's and is left alone. A snoozed agent is meant to disappear for a short while and come back. The person's action sends it to the background, and the platform brings it to the foreground when the time is up.
- **The signals are defined before the middle is.** What sending an agent to the middle means, and when a person wants to, follows from exactly which signals reach the person from an agent there. Whether a person can choose to move an agent into the middle waits on that.

## Rulings: the Fleet page

- **The middle belongs on the Fleet page.** Its definition already gives each row four questions answered from measurements, and the Playbooks definition adds the step.
- **An event on an agent nobody is reading reaches the person through the Fleet page and the badge on its entry.** That is enough. The [Fleet page](../product/features/fleet-page.md) definition already says the badge counts agents with a measured problem.
- **The middle feels unsolved because the Fleet page is half-built**, not because the product is wrong. It does not work quite right, and in many ways it sends no meaningful signal yet. Jackson: that is unfinished work, not a core product problem. The details were left for later.

## Set aside

Several people on one server. Settle, snooze and pin are each one value per thread, shared by everyone, as upstream's read marker is (see the [catch-up session](2026-10-10-catch-up-session.md)). If the spectrum describes how one person relates to an agent, they belong to the person.
