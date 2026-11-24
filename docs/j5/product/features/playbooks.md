---
title: "Playbooks"
kind: definition
---

# Playbooks

## Problem

An agent following a long procedure reads it once at the beginning and the later steps decay into the back pages of its context; by step nine it has forgotten what step nine said. A person watching long-running work cannot see progress at a glance — they see a spinner, not a state ([problems](../problems.md): context as bad memory; fleet observability).

## Definition

A **Playbook** is user-authored, step-by-step content for a piece of work. Its run belongs to the thread that started it. A step may name a persona as guidance. On each move, the owner may assign that step to an eligible local agent it spawned or to a member of a Crew it captains; otherwise the owner holds it.

**The engine is the platform's; the steps are the user's.** The platform holds the step pointer, keeps instructions fresh, and renders progress. The steps, their content, and the judgment that a step is done belong to the Playbook and the agents following it. This is how a workflow like the PR Group becomes expressible on the platform without being codified into it.

It runs in three moves. **An agent declares when to advance** through a tool call, so "what step are they on" is a cheap, honest, measured fact — asserted by the agent, visibly so, never parsed from output or inferred by the platform. **On each move, the platform delivers the step's instructions to its owner**, fresh in context: the recorded holder, or the owner when no assignee is named; this is what defeats read-once-and-forget. **The interface renders progress** from the step pointer: which step each owner agent is on, at a glance. Playbook run tools only read prompts and move the calling thread's own run; they never run a step or touch the workspace. So J5 pre-approves them wherever it pre-approves its other tools (Codex and Claude, [divergence D3](../upstream.md)), and every other harness keeps its own approval prompts.

Definitions live in the environment's library, available from every project and worktree on that server, and in folders the environment is configured to read. A project can also keep its own definitions in `.j5/playbooks/`; inside that project they override a library definition with the same name. Saving a definition to the library is a separate writing operation, pre-approved the same way but refused to read-only personas and plan-mode callers. An agent edits a library definition only against the version it read, so it can't overwrite a change it hasn't seen.

Playbooks are linear sequences. The initiative-level view — a plan whose nodes are Crews' Playbook positions — is the same idea one level up, with a recorded position for each run. A Playbook is not a workflow engine: no platform-owned branching, retries or step-level automation. Where a step needs judgment, an agent judges.

## Acceptance criteria

1. A Playbook is a user-authored file the platform reads; it never generates or edits steps.
2. An agent can start a Playbook run and assign each step at runtime, including a step held by a Crew member it captains.
3. An agent advances a Playbook through a tool call with its expected current step; the platform never advances a step on its own.
4. The current step and its holder are recorded facts of the owner agent’s run.
5. On each move, the recorded holder receives the saved step instructions. Pending delivery is visible and does not imply execution.
6. The interface shows the current step and holder beside each owner agent, with pending delivery visible.
7. A Playbook has no branching, retry, or automation owned by the platform.
8. Starting a run saves its parsed procedure. Editing a saved playbook changes future runs only; active runs keep their steps, prompts, title, and purpose.
9. Deleting a saved playbook succeeds while a run uses its copy. On upgrade, active runs without a saved copy are cancelled. Past runs without a copy show their name, status, last step, and any cancellation reason without a step list.
10. Back navigation changes the recorded position without undoing work, and retries cannot advance an active run twice.
11. Cancelling ends the run before requesting upstream Stop on a non-owner holder, under the owner's Stop authority and mode limits. It never interrupts the owner's cancelling turn. The result durably reports no holder, owner-held, Stop requested, already idle, or failure with a reason; cancellation succeeds on Stop failure and retries never issue another Stop. Completion and cancellation preserve work, artifacts, conversation, Crew, workspaces, and run history.
12. Archiving or deleting the owner thread cancels its active run with a reason, immediately or at boot if the server missed it. Unarchiving never reopens the run. Archiving a Crew alone leaves its owner's run active; an archived holder remains visible until the owner reassigns or takes back the step. An interruption and Continue preserve the active run, its saved copy, current step, and holder without repeating completed work.
13. New playbooks are saved to the environment library by default and are available across its projects and worktrees without a promotion step.
14. A project's `.j5/playbooks/` definitions are discovered in that project and override a same-named library definition there; creating one is an explicit choice.
15. Duplicate library names and unavailable sources are visible errors; running procedures retain their saved copy when discovery changes.
16. Copying a definition between environments creates an independent copy without replacing an existing different definition.
17. An agent can edit a library definition; the edit is refused if the definition changed since the agent read it.

18. On the user's explicit request or approved proposal, the owner can revise an active run's steps without changing the reusable definition or other runs. The run records each revision's basis, time, and owner; history shows its revision count and latest basis. A revision preserves the current step by stable ID or requires an explicit replacement step, and stale calls and retries cannot apply it twice.

## Scenarios

- **A release Playbook.** The user writes a five-step release Playbook and an agent starts it. The owner assigns step 2 to a Builder Peer Agent it spawned. Fleet shows step 2 beside the owner and names the Builder as holder. When the Builder reports back, the owner advances and assigns step 3 to a Crew member it captains. (AC2, AC3, AC5, AC6)
- **An unavailable holder.** The current step's notice cannot reach its archived holder. Fleet shows the recorded holder and pending status. The owner assigns the same step to another eligible agent or takes it back; the old notice retry does not deliver it to the archived holder. (AC4–AC6)
- **A judgment step.** Step 4 says "decide whether the migration is safe to run"; the platform delivers the instruction and waits — the agent decides, and declares. (AC3, AC7)

- **A saved single-agent procedure.** In Billing Migration, a Role keeps following the procedure it started while the user edits or deletes its library definition. A new run uses the edited definition. The Role can move back to inspect earlier work; deleting its owner thread cancels the run. (AC8–AC12)

## History


- 2026-08-22 — the concept; former R27 ([record](../../worklog/2026-08-21-design-review.md)).
- 2026-09-08 — rewritten into the definition shape. Former identifiers: R27(a) → AC3–AC4; R27(b) → Definition (linear first); R27(c), skills per step → not part of the definition, parked. The questions for the Playbooks design session — the step schema, how a Playbook attaches at spawn, the delivery channel for step advancement, the initiative-level view, what "declared complete" means for a multi-agent step — are that session's, not this definition's.

- 2026-09-29 — a Crew's run is its Captain's: one owner per step with the Captain as fallback, and archiving a Crew or its Captain cancels its run (Definition, AC5, AC12; [review](https://github.com/Jacksondr5/j5code/pull/384#discussion_r4140075782)).
- 2026-09-30 — a Crew can be built from a playbook the user's crew request asks to use, by an `@playbook:` mention or by name, but not one named only in passing (Bryant's ruling (a) on #387): the Captain owns the run (1A), each step names the persona that does it (2A), and the Crew records the playbook it follows (3A). A named persona that is missing, disabled, or blocked gets a stand-in seat (Bryant; #319, #321, #322, #323).
- 2026-09-23 — restored the end-state definition and AC1–AC7 traceability; clarified live edits, agent-declared movement, terminal history, and deleted-owner recovery ([review](https://github.com/Jacksondr5/j5code/pull/248#discussion_r4084815885)).
- 2026-09-29 — which harnesses pre-approve Playbook tools moved here from an edit to upstream's provider docs (Jackson, [#329](https://github.com/Jacksondr5/j5code/pull/329)).
- 2026-10-19 — an environment-wide library and configured folders join workspace discovery, with a project's own definitions winning inside it; independent copies between environments; agents edit library definitions against the version they read (AC13–AC17, [#613](https://github.com/Jacksondr5/j5code/issues/613)).
- 2026-11-06 — a playbook Crew gets a stand-in seat only for a persona the server doesn't have; a disabled, invalid or blocked persona keeps its steps with the Captain, who escalates it (Bryant; [#785](https://github.com/Jacksondr5/j5code/issues/785)).
- 2026-11-24 — Each new run snapshots its definition. Upgrade cancels active runs without a snapshot and preserves terminal history ([#795](https://github.com/Jacksondr5/j5code/issues/795)).

- 2026-11-24 — Owners can revise the steps of an active run. Run history records the revision count and latest reason ([#787](https://github.com/Jacksondr5/j5code/issues/787)).
- 2026-11-24 — The run owner assigns each step at runtime to an eligible local holder. A Crew no longer assigns steps when its roster is proposed ([#788](https://github.com/Jacksondr5/j5code/issues/788)).
- 2026-11-24 — Archiving or deleting the owner cancels its run. Recovery interrupts only the turn that received the cancelled step ([#789](https://github.com/Jacksondr5/j5code/issues/789)).
