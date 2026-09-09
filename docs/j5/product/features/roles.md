---
title: "Roles"
kind: definition
---

# Roles

## Problem

A fleet ends up with many agents doing the same kind of job — reviewers, sitters, builders, monitors. Without a reusable definition, every one of them is set up by hand, drifts from the others, and cannot be handed to another person or another agent to spawn. The user who ran the prior-art fleet built a definition system themselves, and managing it was a mess ([problems](../problems.md): Roles defined in platform tooling). Agents also spawn agents, and an agent choosing a kind of helper for the user's budget needs something better than a guess.

## Definition

A **Role** is a reusable, user-authored definition of a kind of agent. It is the user's content — a file, portable and shareable — that the platform reads so that spawning the right kind of agent is easy for people and for agents alike.

A Role defines:

- **A one-line purpose** — the sentence that answers "what is this kind of agent for." It serves every picker, human and agent; a Role without one cannot be chosen deliberately.
- **Identity content**, in two plain-markdown sections that stay in the agent's context for its whole life: **Identity** (who this agent is — values, voice, standing norms; the part that solidifies and is rarely edited) and **Operating Principles** (how it works at a high level; the part that evolves with the user's practice). There is deliberately **no prompt in the definition**: the spawner's brief is the prompt, written per instance, and step-by-step operation belongs to a Playbook.
- **A model and reasoning allowlist**, ordered. It constrains the choice at spawn; it never chooses silently for an agent.
- **A skill allowlist** — the skills exposed to the agent. This is the one part only the platform can enforce: nobody can gate a tool surface from a markdown file.
- **A posture on the human-contact spectrum** — how much this kind of agent talks with the person through chat, from Foreground to Background, with the middle allowed — so its communication norms are set at spawn.

Roles are authored and edited **in the app**, in a simple markdown editing surface; nobody is pushed out to an external editor to participate. The files remain the substance. Git is optional: a plain folder works with everything except the git controls, and a library pointed at a git repository gets exactly three operations — commit, push, pull — plus nudges when there are uncommitted changes or the remote is ahead. Anything difficult, such as a conflict or a failed push, goes to the user's editor with the error shown. This is deliberately not a differentiator. One library location, configurable.

The **Role Library** lists every Role with its purpose, its posture, and where it is in use. No memory travels in a Role: provider memory is accepted as non-portable local seasoning; what an agent must never forget belongs in its definition.

**Spawning with a Role.** A person picks a Role in the composer's Role dropdown (none selected by default — plain agents remain the default path); selecting one constrains the model and reasoning selectors to the allowlist, with disallowed entries visible but disabled and labeled with the Role that excludes them, and switches an invalid current model to the first allowed one with a visible cue. The spawned thread carries a Role chip. An agent picks a Role from the spawn listing, which shows each Role's purpose, posture and cost tier, because the choosing agent decides on the person's behalf and budget; provider, model and reasoning stay explicit on every agent spawn, constrained by the allowlist and never defaulted for it. A Role is spawnable solo or composed into a Crew.

**Editing a definition never silently changes a running agent.** New spawns get the new definition; running agents keep what they absorbed. What the platform owes is visibility: every agent, and every Crew as a unit, shows a measured **drift** indicator when its definition has changed since it was spawned. The remedy — respawn, or message the agent — is always a person's or Captain's judgment.

A Role is **not** a runtime object (the agent is), **not** a permission boundary beyond skill gating, and **not** a behavior guarantee: it raises the odds and sets expectations; behavior remains a prompting matter. Prose in a Role ("escalate to your Builder") is never parsed or validated.

## Acceptance criteria

### The definition

1. A Role is a file the user can read, copy, and share; the platform reads it and never rewrites it.
2. A Role has a required one-line purpose; a Role without one is not offered by any picker.
3. A Role's identity content is two markdown sections, Identity and Operating Principles, and both are present in the agent's context for its whole life.
4. A Role contains no prompt; the spawner's brief is the first-turn prompt.
5. A Role's model and reasoning allowlist is ordered, and its skill allowlist is enforced by the platform at spawn.
6. A Role declares a posture on the human-contact spectrum, and the spawned agent's communication norms follow it.

### Authoring

7. Roles can be created and edited in the app; the app never requires an external editor for ordinary editing.
8. A library in a plain folder works for everything except the git controls; a library in a git repository offers commit, push and pull and nothing else, and surfaces uncommitted changes and a remote that is ahead.
9. A git operation that fails or conflicts opens the user's editor with the error shown.
10. The Role Library shows every Role's purpose, posture, and current use (agents running, Crews referencing it).

### Spawning

11. The composer's Role dropdown selects no Role by default and shows each Role as name plus purpose.
12. Selecting a Role in the composer disables disallowed models and reasoning levels, labels each with the Role that excludes it, and switches an invalid current selection to the first allowed entry with a visible cue.
13. The spawned thread carries a Role chip.
14. An agent's spawn listing shows each Role's purpose, posture and cost tier; an agent spawn with a Role still names provider, model and reasoning explicitly, and a choice outside the allowlist is refused naming the Role.

### Change

15. Editing a Role never changes a running agent.
16. An agent whose Role file changed since it was spawned shows a drift indicator; a Crew shows one when any of its definition files changed.
17. Prose in a Role is never parsed or validated.

## Scenarios

- **A reviewer Role.** The user writes "Reviewer" — purpose "reviews other agents' pull requests for correctness", Identity and Operating Principles, an allowlist of two frontier models at high reasoning, review-oriented skills, Background posture. In the composer they pick Reviewer; the cheap model they had selected is disabled and labeled "excluded by Reviewer", the first allowed model is selected with a cue, and the new thread wears a Reviewer chip. (AC2, AC6, AC11–AC13)
- **An agent spawns a helper.** A Captain in Billing Migration reads the spawn listing — Reviewer: purpose, Background, high cost tier — and spawns one, naming provider, model and reasoning within the allowlist. (AC14)
- **A definition changes underfoot.** The user tightens Reviewer's Operating Principles while two Reviewers are running; both show drift; the user respawns one and leaves the other to finish. (AC15, AC16)
- **A plain folder.** The user keeps Roles in a folder with no git; everything works and the git controls are simply absent. (AC8)

## History

- 2026-08-21 — identity is git-versioned definition files with no memory in the bundle; machine-read fields wrap the prose (former R8, R28; posture rider of former R23) ([record](../design-review-2026-08-21.md)).
- 2026-08-23 — the product session: app as editing surface, composer Role dropdown, two-section identity with no prompt, drift never hot-reloads, structured-only validation, minimal in-app git; former P-A–P-F ([record](../../worklog/roles-crews-session-2026-08-23.md)).
- 2026-08-30 — provider, model and reasoning stay explicit on agent spawns even with a Role; the allowlist constrains ([record](../../worklog/spawning-guide-session-2026-08-30.md)).
- 2026-09-08 — rewritten into the definition shape; posture stated with the middle of the spectrum allowed, matching the lens. Former identifiers: R8 → AC1, Definition (no memory); R28 → AC1, AC5; P-A, P-F → AC7–AC9; P-B(h) → AC11–AC13; P-B(a) → AC14; P-C → AC3–AC4; P-D → AC15–AC16; P-E → AC17. Deferred items that lived here (Role claims, multiple library locations) are backlog candidates.
