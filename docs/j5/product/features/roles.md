---
title: "Roles — reusable agent definitions in platform tooling"
kind: spec
---

# Roles

Feature definition of record. The problems and goals it serves ([problems doc](../problems.md)): fleets naturally end up with many agents performing the same type of job, and managing those definitions today means self-built solutions — Jackson built one for the prior-art fleets and managing it was a mess. Rulings baked in: R8, R28 in [the register](../design-review-2026-08-21.md), plus the item-3 product session ([worklog record](../../worklog/roles-crews-session-2026-08-23.md)).

## The Role

A **Role** is a reusable, user-authored definition of a kind of agent. It defines:

- **A required one-line purpose** — the sentence that answers "what is this kind of agent for." It serves both pickers (human dropdown and agent tool listing); a Role without it is not spawnable-by-choice, only by accident.
- **Identity content in two sections**, both plain markdown, both persistent in the agent's context for its whole life:
  - **Identity** — who this agent is: values, voice, standing norms. The part the user lets solidify and rarely edits.
  - **Operating Principles** — how it works at a high level: principles, what it looks for and does in general. Evolves with the user's methodology.
  - There is deliberately **no prompt in the definition** — the spawner's brief is the prompt, written per instance. Step-by-step operation belongs to [Playbooks](playbooks.md), not the Role.
- **A model and reasoning-level allowlist** — so agents that spawn other agents with Roles choose the right ones. Ordered; the first entry is the default.
- **A skill allowlist** — the set of skills exposed to the agent. This is the platform-only part: nobody can gate an agent's tool surface from a markdown file.
- **Posture on the [human-contact spectrum](../principles.md)** — Foreground or Background, so the agent's communication norms are set at spawn.

Roles make it easy for users _and agents_ to spawn the right kind of agent for a task. A Role is spawnable solo, or composed into a [Crew definition](crews.md) as one of its seats.

## Authoring: the app is an editing surface

Users author and edit Roles **in the app** — a simple markdown editing surface; nobody is pushed out to an external editor to participate. The substance remains **files** (R28): portable, shareable, versionable however the user wants. Git is **optional** — a plain folder works with everything except the git UI; users who point the library at a git repo get exactly three operations in-app — **commit, push, pull** — plus nudges ("you have uncommitted Role changes", "remote is ahead"). Anything difficult — merge conflicts, failed pushes — punts to the user's editor with the error shown (the app already opens it in one click). This is deliberately not a differentiator; minimal effort, forever. One library location in v1 (a default path, configurable); multiple sources are deferred until wanted.

The **Role Library** view lists every definition with its purpose, posture, and where it's in use ("3 agents running, 1 Crew references this"). **No memory in the bundle** (R8): provider memory is accepted as non-portable local seasoning; what an agent must never forget belongs in its definition.

## Spawning with a Role

**Human — folded into the existing new-chat composer:** a Role dropdown below the worktree row, **none selected by default** (plain agents remain the default path). Selecting a Role:

- **constrains** the model and effort selectors to the Role's allowlist — disallowed entries stay visible but disabled, labeled with the Role that excludes them (impossible to re-select into an invalid state);
- **auto-switches** the current model to the first allowlisted one if it's invalid — with a visible cue on the model chip (the change must be watched, not discovered);
- shows each Role in the dropdown as name + one-line purpose.

The spawned thread carries a **Role chip**. Crew spawning is a **separate surface** (a Crew is launched, not chatted with) — its human UI is deferred to the implementing dev, with the differentiation requirement recorded.

**Agent — the spawn tool listing** shows purpose + posture + cost tier per Role, because the choosing agent decides on the user's behalf and budget.

## Definition changes and drift

**Editing a definition never silently changes a running agent.** New spawns get the new definition; running agents keep what they absorbed — anything else lies about how agents work. What the platform owes instead is visibility: every agent (and Crew, as a unit — any of its definition files) shows a measured **drift indicator** when its definition has changed since spawn. The remedy — respawn, or message the agent — is always human/Captain judgment.

## What a Role is not

Not a runtime object (the agent is), not a permission boundary beyond skill gating, and not a behavior guarantee — a Role raises the odds and sets expectations ([tools, not guarantees](../principles.md)); behavior remains a prompting problem. Prose in a Role ("escalate to your Builder") is never parsed or validated — wiring correctness at the prose level is a prompting concern.

## Deferred (with reasons)

- **Role claims** (Traycer's runtime self-designation): seats inside Crews make responsibility explicit; the loose-agent duplication problem hasn't been observed on-platform. Revisit on evidence.
- **Multiple library locations** (per-project, shared team libraries): extend when wanted.
- **In-app advanced git**: never — the editor owns it.
- **Technical design** (file format, discovery mechanics, tool schemas): owned by the implementing dev, within these product rulings.
