---
title: "Roles — reusable agent definitions in platform tooling"
kind: spec
---

# Roles

Feature definition of record. The problems and goals it serves ([problems doc](../problems.md)): fleets naturally end up with many agents performing the same type of job, and managing those definitions today means self-built solutions — Jackson built one for the prior-art fleets and managing it was a mess. Rulings baked in: R8, R28 in [the register](../design-review-2026-08-21.md).

## The Role

A **Role** is a reusable, user-authored definition of a kind of agent. It defines:

- **Identity and prompt content** — `SOUL.md`/`AGENTS.md`-style identity, bootstrap instructions, and a prompt.
- **A model and reasoning-level allowlist** — so agents that spawn other agents with Roles choose the right ones.
- **A skill allowlist** — the set of skills exposed to the agent. This is the platform-only part: nobody can gate an agent's tool surface from a markdown file.
- **Posture on the [human-contact spectrum](../principles.md)** — Foreground or Background, so the agent's communication norms are set at spawn ("your counterpart is the human; keep replies one screen" / "you never chat with the human; your channels are your Captain, your peers, and the inbox").

Roles make it easy for users _and agents_ to spawn the right kind of agent for a task. A Role is spawnable solo, or composed into a [Crew definition](crews.md) as one of its seats.

Example: a user defines a "reviewer" Role for reviewing code other agents build — higher-reasoning frontier models in its allowlist, skills geared toward code review, a prompt tuned for what to look for.

## Platform schema, file storage

The definition is a structured document: machine-read fields (model allowlist, effort, skills, posture, Playbook reference) wrapping the prose identity/prompt content. The platform enforces the mechanics because it _reads_ them — mechanics never have to be described in prose. Storage is files, and that is a feature, not a fallback (R28):

- **It is the user's content, not ours.** Portability and shareability are requirements — users store, version, and share Roles however they want. Git currently solves versioning, portability, and cross-device travel for free; **the implementation must not un-solve this.**
- **No memory in the bundle** (R8). Provider memory is accepted as non-portable local seasoning; what an agent must never forget belongs in its definition, which the user curates. Identity portability comes from the files.

## What a Role is not

Not a runtime object (the agent is), not a permission boundary beyond skill gating, and not a behavior guarantee — a Role raises the odds and sets expectations ([tools, not guarantees](../principles.md)); behavior remains a prompting problem.

## Open — the item-3 design session owns these

The definition schema and file format; where Role files live and how the platform discovers them; the spawn tool surface; versioning UX (what happens to running agents when a Role changes); posture declaration syntax. Nothing here should be treated as designed until that session closes.
