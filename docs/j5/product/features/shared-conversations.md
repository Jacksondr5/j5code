---
title: "Shared conversations"
kind: definition
---

# Shared conversations

## Problem

Two people who want the same agent's help relay it to each other: one asks their agent and pastes the answer to the other. Putting both in front of the same agent removes the relay ([problems](../problems.md): Shared server). It also gives the agent a problem it has never had. A conversation has always had one human voice, and an agent given two cannot tell them apart, does not know whose word carries, and has no way to ask one of them something where the other can see.

## Definition

A **shared conversation** is a thread that more than one person can write to: a thread a guest holds a Collaborate grant on ([Shared server](shared-server.md)). A thread only one person can write to is unchanged by anything here.

**The agent is told who is speaking.** The server puts the author's name on each person's message, in the text the agent reads, the way it names the sender of a message from another agent. The name comes from the connection the message arrived on, so a person cannot write as someone else. When a thread first becomes shared, the agent is told once who can now write to it, and that the unnamed messages before that point came from a member.

**Members outrank guests, and the agent is told why.** The same note says that members own the server the agent runs on, that guests take part at a member's invitation, and that a guest is not fully trusted unless a member says so: members decide what a guest may tell the agent to do. The agent works with a guest normally. When a guest's request conflicts with what a member said, or goes well beyond the work in the thread, it holds off and asks a member. The member who shares can say what the guest is there for, and that line is part of the note; a member can widen or narrow a guest's standing at any time by saying so in the thread.

This is guidance the agent is given, not a rule the platform enforces. An agent reads every message as text, and nothing can make it rank one author above another. Members of one server are equals, and a disagreement between them is an ordinary change of mind; a thread has no owner among them.

**The agent asks in the conversation.** In a shared conversation an agent puts a question to a person in the thread, by name, where everyone sees the question and the answer. It does not send an ask to a person's inbox from there: a private question to one person works against a conversation everyone is in.

**A guest queues; a member steers.** A guest's message starts the agent when it is idle and waits behind the current work when it is not. Only a member interrupts work in progress or stops it. A guest can change or withdraw a message of their own that is still waiting.

**Each person reads their own messages as they always have**, and other people's as cards that carry the author's name and picture. A person's picture is their GitHub profile picture, from a username they enter in their own client. Nothing shows who else is present or typing.

**A shared conversation is shared whole.** A person added to it reads it from the beginning. Hiding the earlier part would be a promise the platform cannot keep, since a collaborator can ask the agent what was said. A person whose access is removed loses the thread, and their messages stay in it under their name.

## Acceptance criteria

### Authors

1. In a thread a guest holds a Collaborate grant on, every message a person sends reaches the agent with its author's name, taken from the session that sent it; a client cannot set or change it.
2. In a thread only one person can write to, a message reaches the agent as it does without this feature.
3. When a thread gains its first guest collaborator, the agent receives one note naming who can now write to it and saying that earlier unnamed messages came from a member.
4. When a collaborator is added to or removed from a thread that is already shared, the agent receives one note saying so.

### Standing

5. The note of AC3 states that members own the server, that guests are invited by a member and are not fully trusted unless a member says so, and that members decide what a guest may ask of the agent.
6. The Share dialog offers an optional line saying what the guest is there for; when filled in, the note carries it.
7. No message from a guest is refused, altered or held by the platform on account of its content.

### Asking a person

8. In a shared conversation, an agent's ask to a person's inbox is refused, with an error telling it to ask in the thread and name the person.
9. In a thread with no guest collaborator, an agent's ask to a member behaves as the [inbox](inbox.md) defines.

### Queueing and steering

10. A guest's message sent while the agent is working is queued behind the current work; a guest has no way to steer it into the current work.
11. A guest cannot stop or interrupt a run.
12. A guest can edit and remove their own queued messages, and no one else's; a member can edit and remove any queued message.

### Reading

13. A person's own messages render as they do in a thread that is not shared; another person's messages render as cards carrying that person's name and picture.
14. A person's picture is the GitHub profile picture for the username they entered in their client's settings; a person with no username, or a picture that cannot be loaded, shows initials on a coloured circle.
15. The server stores a person's GitHub username and never a picture address; a member who manages access can clear it from the People page.
16. No surface shows that another person is viewing the thread or typing.

### History

17. A person added to a thread can read all of it, from its first message.
18. When a person's access to a thread is removed, their messages remain in it under their name.

## Scenarios

- **Two people, one agent.** The user gives a second developer Collaborate on a thread in Billing Migration, and writes "reviewing the migration plan with me" in the Share dialog. The agent receives a note naming the developer, the line the user wrote, and where guests stand. The developer asks the agent a question; it arrives under their name and the agent answers it. On the user's screen the question is a card with the developer's picture; on the developer's it is an ordinary message. (AC1, AC3, AC5, AC6, AC13, AC14)
- **A request beyond the work.** The developer asks the agent to delete the staging database. The agent does not, and writes in the thread that it is holding off and asks the user, by name, whether to go ahead. The user says no. Everything is visible to both. (AC5, AC7)
- **A question for one of them.** The agent needs a decision only the user can make. Its attempt to send the user an ask is refused, and the error tells it to ask in the thread. It writes the question there, addressed to the user by name. (AC8)
- **The agent is busy.** The developer sends a message while the agent is running tests. It queues. They spot a typo, fix it while it waits, and it reaches the agent when the tests finish. They see no control for stopping the run; the user stops it when asked. (AC10, AC11, AC12)
- **A private thread.** The user's other threads in the project have no collaborator. Their messages carry no name and an agent there asks through the inbox as before. (AC2, AC9)
- **Joining late.** A third person is given View on the thread a week in. They read it from its first message. (AC17)
- **Leaving.** The developer's grant is removed. The thread leaves their list, the agent is told they can no longer write, and their earlier messages still carry their name for the user. (AC4, AC18)

## History

- 2026-10-10 — defined (Jackson; [record](../../worklog/2026-10-09-multi-player-session.md)). AC12 is tentative: if a guest managing only their own queued messages proves a mess to build, a guest gets either a member's rights over the queue or none.
