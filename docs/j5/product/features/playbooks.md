---
title: "Playbooks"
kind: definition
---

# Playbooks

## Problem

An agent following a long procedure reads it once at the beginning and the later steps decay into the back pages of its context; by step nine it has forgotten what step nine said. A person watching long-running work cannot see progress at a glance — they see a spinner, not a state ([problems](../problems.md): context as bad memory; fleet observability).

## Definition

A **Playbook** is user-authored, step-by-step content for a piece of work. Its run belongs to the thread that started it. A step can require a saved persona. The owner may assign a step to an eligible local agent it spawned or to a member of a Crew it captains. A required persona must match the holder's launch assignment, including when the owner holds the step. An unnamed step can go to any eligible agent or the owner.

**The engine is the platform's; the steps are the user's.** The platform holds the step pointer, keeps instructions fresh, and renders progress. The steps, their content, and the judgment that a step is done belong to the Playbook and the agents following it. This is how a workflow like the PR Group becomes expressible on the platform without being codified into it.

It runs in three moves. **An agent declares when to advance** through a tool call, so "what step are they on" is a cheap, honest, measured fact — asserted by the agent, visibly so, never parsed from output or inferred by the platform. **On each move, the platform delivers the step's instructions to the recorded holder**, fresh in context; this is what defeats read-once-and-forget. **The interface renders progress** from the step pointer: which step each owner agent is on, at a glance. Playbook run tools only read prompts and move the calling thread's own run; they never run a step or touch the workspace. So J5 pre-approves them wherever it pre-approves its other tools (Codex and Claude, [divergence D3](../upstream.md)), and every other harness keeps its own approval prompts.

Definitions live in the environment library, available from every project and worktree on that server. J5 also reads configured team folders. An environment library copy can override a same-named team definition. A project's `.j5/playbooks/` definitions take precedence within that workspace and follow the workspace's write access. Playbook Author shows the full YAML and waits for approval before writing. Only an environment Owner can save to the library. An agent's library save requires an authenticated Owner to start the current chat turn and a library edit checks the digest of the version the agent read.

Playbooks are linear sequences. The initiative-level view — a plan whose nodes are Crews' Playbook positions — is the same idea one level up, with a recorded position for each run. A Playbook is not a workflow engine: no platform-owned branching, retries or step-level automation. Where a step needs judgment, an agent judges.

## Acceptance criteria

1. A Playbook is a user-authored file the platform reads; it never generates or edits steps.
2. An agent can start a Playbook run and assign each step at runtime, including a step held by a Crew member it captains.
3. An agent advances a Playbook through a tool call with its expected current step; the platform never advances a step on its own.
4. The current step and its holder are recorded facts of the owner agent’s run.
5. On each move, the recorded holder receives the saved step instructions. Pending delivery is visible and does not imply execution.
6. The composer shows “Step N of M · current step title” from the recorded position, not completed work. Expanding shows the playbook title, full step list with the current position marked, and the holder’s name when another agent holds it. Waiting for approval reflects the run’s open checkpoint; Blocked reflects an unstaffed required first step or another open ask from its owner to a person. Every thread viewer sees the same flags, regardless of recipient, and they clear when answered or withdrawn without reloading. Web, desktop, and mobile share these semantics; the status flags reveal no other ask’s contents. Fleet shows the current step and holder beside each owner agent, with pending delivery visible.
7. A Playbook has no branching, retry, or automation owned by the platform.
8. Starting a run saves its parsed procedure. Editing a saved playbook changes future runs only; active runs keep their steps, prompts, title, and purpose.
9. Deleting a saved playbook succeeds while a run uses its copy. On upgrade, active runs without a saved copy are cancelled. Past runs without a copy show their name, status, last step, and any cancellation reason without a step list.
10. Back navigation changes the recorded position without undoing work, and retries cannot advance an active run twice.
11. Cancelling ends the run before requesting upstream Stop on a non-owner holder, under the owner's Stop authority and mode limits. It never interrupts the owner's cancelling turn. The result durably reports no holder, owner-held, Stop requested, already idle, or failure with a reason; cancellation succeeds on Stop failure and retries never issue another Stop. Completion and cancellation preserve work, artifacts, conversation, Crew, workspaces, and run history.
12. Archiving or deleting the owner thread cancels its active run with a reason, immediately or at boot if the server missed it. Unarchiving never reopens the run. Archiving a Crew alone leaves its owner's run active; an archived holder remains visible until the owner reassigns or takes back the step. An interruption and Continue preserve the active run, its saved copy, current step, and holder without repeating completed work.
13. New playbooks are saved to the environment library by default and are available across its projects and worktrees without a promotion step.
14. A project's `.j5/playbooks/` definitions are discovered in that project and override a same-named library definition there; creating one is an explicit choice.
15. An Owner can approve a same-named library copy after seeing that it hides later team updates. Settings marks the override, and deleting it restores the team version. Duplicate names across team folders and unavailable sources are visible errors. Running procedures retain their saved copy when discovery changes.
16. Copying a definition between environments creates an independent copy without replacing an existing different definition.
17. An agent can edit a library definition; the edit is refused if the definition changed since the agent read it.

18. On the user's explicit request or approved proposal, the owner can revise an active run's steps without changing the reusable definition or other runs. The run records each revision's basis, time, and owner; history shows its revision count and latest basis. A revision preserves the current step by stable ID or requires an explicit replacement step, and stale calls and retries cannot apply it twice.

19. A step may require approval. Attempting to leave it opens one owner-attributed request containing the step title and the submitted work summary, then refuses movement until an Owner or Collaborator who writes to the owner thread approves. The Inbox and owner chat share its answer across devices; Viewers cannot answer. Decline returns its reason to the owner. Requests and results survive restart; revisits and changed current work require fresh approval, and cancellation or owner archive/deletion closes pending requests. Approval never advances the run or replaces other permission rules.

20. A required persona must match the holder's recorded persona on each handoff. If a required first step cannot be staffed, the run starts without handing off that step or advancing past it. Assigning a matching holder when the persona is available recovers the same run. A later rejected handoff preserves the current step and holder.
21. Start reports availability for every required persona, including limits on the owner's model choices or access. One request in the owner's chat and Inbox covers all limited personas. The server Owner's approval lets the run owner launch the approved personas as person picks for that run. Step approvals remain independent. Existing persona rules still apply, including reviewer model preference at launch.

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

- 2026-11-24 — required steps use a single Inbox exchange for the submitted work summary. The owner sees the decision in chat, and revisiting the step requires a fresh approval ([#790](https://github.com/Jacksondr5/j5code/issues/790)).
- 2026-11-24 — The composer shows the current step and holder across web and mobile. Waiting for approval follows the checkpoint Exchange, and Blocked follows other open asks from the owner ([#791](https://github.com/Jacksondr5/j5code/issues/791)).
- 2026-11-24 — an environment Owner can save a library override of a team-folder playbook. Conversation saves use the shared-conversation attribution of the message that started the turn ([#794](https://github.com/Jacksondr5/j5code/issues/794)).
- 2026-11-24 — a required persona must hold its step. The start request covers the named personas for the rest of the run, replacing the earlier stand-in and Captain fallback rulings. [#792](https://github.com/Jacksondr5/j5code/issues/792)
