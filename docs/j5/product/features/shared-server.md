---
title: "Shared server"
kind: definition
---

# Shared server

## Problem

As agents do more of the work, the need to share them between people grows. A level-2 support team hands its agents from one shift to the next and wants **no context transfer**. Two developers already relay agent output to each other over chat — one asks their agent, pastes the answer to the other — and would rather stand in front of the same agent together ([problems](../problems.md): Shared server; [use cases](../use-cases.md)).

## Definition

**Shared server** is several people on one server sharing its projects and agents. It is one of three distinct capabilities in the multi-machine, multi-person space, and the only one where no state crosses machines and no server peers with another:

| Capability        | Shape                                                            | Defined in                         |
| ----------------- | ---------------------------------------------------------------- | ---------------------------------- |
| Cross-device      | one person, several servers; views merge in the client           | [cross-device](../cross-device.md) |
| Federation        | two people's servers exchange messages through the peer registry | [cross-device](../cross-device.md) |
| **Shared server** | **several people on one server, sharing projects and agents**    | this document                      |

Two constraints are in force on everything built, because retrofitting multiple people onto single-person assumptions is the expensive path this avoids:

- **Nothing may assume exactly one person.** Every person-facing surface — the inbox, the backlog pane, notifications, addressing — is scoped to a person, never to "the user."
- **Every person has a durable person id**, carried on every ledger row and envelope. The id is stable without being authenticated, so how a person signs in can change without changing who they are.

**Two kinds of person.** A **member** is a person the server belongs to: a member reaches every project and every agent on it. A **guest** is a person a member invited to part of it: a guest reaches only what they have been granted. A member who may manage access to the server is the only kind of person who brings anyone in.

**A grant** is what gives a guest their access. It names a person, a project or a thread, and a level. A guest can hold several, at different levels, and their access changes when a grant is added, changed or removed on the server; nothing is sent to the guest again. A grant on a thread covers that thread and the agents beneath it, its spawned agents and its Crew seats, and nothing the thread has merely exchanged messages with. A grant on a project covers every thread in it and the project's artifacts.

**Two levels.** **View** lets a guest read. **Collaborate** lets a guest also write to the agent: send it messages, answer its questions and approval prompts, and drive the thread's preview browser ([shared conversations](shared-conversations.md) defines what happens once they do). Neither level includes what belongs to the person running the server: a terminal, the file browser, git and pull request actions, the thread's model and access mode, archiving and forking, or any setting.

**What a share promises.** A view grant is a boundary the server enforces: a guest who can view one thread can read nothing else. A collaborate grant is not a boundary. A person who can write to an agent can ask it to read any file, run any command or message any other agent, so the grant shapes what the guest sees and does not contain what they can cause. The product says this in plain words at the moment a share is made, and does not withhold useful things in order to look stricter than it is.

**A share link** is how a new person first connects. A member who manages access makes it for a named person; opening it pairs one device as that person. A second device takes a second link for the same person. The link carries no access of its own: it says who is connecting, and the grants say what they reach. A link travels over the routes by which the server can already be reached; sharing opens no new route to the server.

**A guest's view** of the product is the threads they were granted, and a project's artifacts when the grant is on the project. A guest has no inbox, no Fleet page, and no Personas or Playbooks, and shares nothing onward.

**An agent addresses a specific member or every member of the server.** There is no group management: one server has a practical ceiling on people and work, and groups are complexity with no identified need. An agent reaches a guest in the conversation they share, never through the inbox.

Doors deliberately left open and undesigned: addressing a _duty_ rather than a person ("the on-call", resolving to whoever holds it now); what an ask to "every member" means when several members can each write to the asking agent's thread; a person who is a guest reading the Fleet page.

## Acceptance criteria

### People

1. No surface, projection or tool assumes exactly one person; each is scoped by person id.
2. Every ledger row and envelope carries the person id of any person it involves.
3. An agent's ask can be addressed to one member or to every member of the server, and to nothing in between; a guest is not addressable through the inbox.
4. A person's id is stable across restarts and does not depend on authentication.
5. Every person on a server is a member or a guest; a member reaches every project and thread on the server, and a guest reaches only what their grants cover.

### Grants

6. A grant names one person, one project or one thread, and one level, View or Collaborate.
7. A person can hold several grants at different levels; where two cover the same thread, the higher level applies.
8. A thread grant covers the thread, the agents it spawned and its Crew seats, at the grant's level. An agent outside that tree appears to the guest by name on a message card and cannot be opened.
9. A project grant covers every thread in the project, and the project's artifacts; a guest whose grant is on a thread sees a link to an artifact and cannot open it.
10. Adding, changing or removing a grant changes what the guest's connected clients show without the guest pairing again.
11. Removing a guest's last grant on a thread removes the thread from their view.

### Levels

12. With a View grant a guest can read the conversation, including its agent-to-agent cards, the diffs and files the thread's work touched, and watch the thread's preview browser tabs; they can send nothing to the agent.
13. With a Collaborate grant a guest can also send and queue messages, answer the agent's questions and approval prompts, and open and drive preview browser tabs for the thread.
14. A guest at either level cannot open a terminal, browse or edit files directly, use git or pull request actions, change the thread's model or access mode, archive, fork or merge back a thread, or change any setting, provider, Persona or skill.
15. A request from a guest for a thread, project or file outside their grants is refused by the server, whatever client sent it.
16. A preview browser tab a guest opens holds no saved logins, and a guest cannot take control of a tab opened with saved logins.

### Sharing

17. Only a member who may manage access to the server can create a grant, change one, remove one, or make a share link. A guest cannot, and an agent cannot.
18. Sharing starts from a Share action on a thread or a project, and from a People page in Settings that lists each person, what they can reach, and their devices.
19. A share link is made for a named person and pairs one device as that person; a link for a further device is made from the People page.
20. A link is produced only for a new person or a new device; giving an existing person more access produces no link.
21. The Share dialog states, before the member confirms, that a person who can write to an agent can have it do anything the agent can do, and that sharing a thread shares all of its history.
22. A share link uses a route by which the server is already reachable; making one opens no tunnel and enables no relay.

### What a guest sees

23. A guest's client lists only the threads their grants cover.
24. A guest has no inbox, no Fleet page, and no Personas or Playbooks pages.

## Scenarios

- **Shift handoff.** The on-shift engineer for Support Rotation goes home; the next engineer, also a member, opens the same server, sees the same project, the same agents, and the same open asks in their own inbox, and continues without a handover conversation. (AC1, AC5, AC3)
- **A reviewer for one thread.** The user opens the Share action on a thread in Billing Migration, names a contractor, and chooses View. The dialog says the contractor will see the thread's whole history. The user sends the link it produces; the contractor opens it, sees that one thread and the two builders beneath it, reads the diff, and finds no composer. Nothing else on the server is listed. (AC6, AC8, AC12, AC19, AC21, AC23)
- **More access, no new link.** Two days later the user gives the same contractor Collaborate on a second thread from the People page. No link is produced. The thread appears in the contractor's client with a composer, while the first thread still has none. (AC7, AC10, AC13, AC20)
- **A whole project.** The user grants a colleague View on Website Redesign. Every thread in the project is listed for them, and they can open the project's artifacts. (AC9)
- **What a guest cannot reach.** A collaborator on one thread finds no terminal, no file browser, and no git actions, and the thread's model and access mode are shown and cannot be changed. A request their client was altered to send, for a file outside the thread, is refused. (AC14, AC15)
- **A second device.** The contractor wants the thread on their phone. The user makes a second link beside the contractor's name on the People page; the phone pairs as the same person and shows the same threads. (AC19)
- **Access removed.** The user removes the contractor's grant on the first thread. It leaves the contractor's list at once; the second thread stays. (AC10, AC11)

## History

- 2026-08-22 — the multi-person invariant and person ids ruled binding now; the capability defined and set apart from cross-device and federation; former R9, R29, and the cross-device position ([record](../../worklog/2026-08-21-design-review.md)).
- 2026-09-08 — rewritten into the definition shape. Former identifiers: R9 → AC2, AC4; R29 → AC1, AC3. The architecture session this capability needs before any build — how several authenticated people attach to one server, attribution and read state in shared surfaces, what "every person" delivery means for the inbox — is that session's agenda, not this definition's.
- 2026-10-07 — Squadrons retired: what several people share on one server is its projects and agents, and the capability is renamed from "Shared Squadrons" to "Shared server" (Jackson, 2026-10-05; [#412](https://github.com/Jacksondr5/j5code/issues/412)).
- 2026-10-10 — members and guests, grants at two levels, and share links defined; two people in one conversation moved out of the open doors and into [shared conversations](shared-conversations.md) (Jackson; [record](../../worklog/2026-10-09-multi-player-session.md)). AC3 now reads "member" where it read "person"; AC5 onward are new.
