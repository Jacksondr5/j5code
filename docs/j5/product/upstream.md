---
title: "J5 and upstream — the three zones, and the register of divergences"
kind: definition
---

# J5 and upstream

J5 Code is a fork of T3 Code, and it stays one. Upstream builds the base product and J5 builds a fleet layer on top ([overview](overview.md)). The fork is only affordable if J5 keeps its changes to upstream few, deliberate, and recorded, because every change is carried through every upstream advance. The principle is [upstream owns its product](principles.md#upstream-owns-its-product). Where upstream is building toward J5's own areas is tracked separately, in the [upstream convergence watchlist](upstream-convergence.md).

## The three zones

Every change lands in one of three zones.

1. **J5's domain.** The areas in the [overview](overview.md), built in J5-owned code. J5's definitions and principles govern them.
2. **Code overlap.** J5 code has to be reached from, or placed inside, a file upstream owns, without changing what upstream's product does. This is a matter of process, and [`FORK.md`](../../../FORK.md) is the whole answer: put the J5 code in J5-owned files, keep the upstream edit to a small appended integration case, and record the case in the same PR.
3. **Product overlap.** A change to what upstream's product does, as a user or agent experiences it: overriding or suppressing upstream behavior, giving an upstream concept a different meaning, or extending an upstream area such as a provider adapter so that it serves a J5 feature. This is the person's decision.

The test for zone 3 is behavioral, not about code size. A one-line edit that makes an upstream control disappear is zone 3; a large J5 module reached through a one-line registry entry is zone 2.

## Deciding a product overlap

An agent whose work heads into zone 3 brings the person:

- **what upstream does today**, and why, if upstream says;
- **what J5 would do instead**;
- **the trade-offs**: what the person gains, what it costs to carry through upstream advances, and what breaks if upstream later changes the same area;
- **the alternatives**, which always include following upstream and saying "not supported here".

The default is to follow upstream. Where upstream's product is less capable than a J5 feature wants, the usual answer is that the J5 feature is not supported there, and a general fix is offered back upstream (tracked in the give-back backlog, [#276](https://github.com/Jacksondr5/j5code/issues/276)).

When the person approves a divergence, it is recorded below and its code gets its FORK.md cases. When the person declines, nothing is recorded here; the ruling lives on the issue or PR where it was made.

## The register of divergences

Every place J5 knowingly makes upstream's product behave differently, with the person's decision behind it. FORK.md is the code-level ledger; this is the product-level one. When upstream makes an entry unnecessary or J5 stops needing it, the entry moves to **Retired** at the end, keeping its ID and heading, with a line saying when and why, so references to it keep working. Gaps in J5's mobile app aren't divergences: mobile is catching up to web as its own effort, and what it lacks is recorded there, not here.

Each entry has an ID ("divergence D7"), which never changes and is never reused. Every entry answers the same questions, in the same order:

- **Upstream:** what T3 Code does.
- **J5:** what J5 does instead.
- **Why:** the problem J5 had with upstream's behavior, and why this answer.
- **Consequences:** what it costs, what to check at each upstream advance, and known gaps.
- **Decided:** who decided, when, and where it's recorded.

Letter codes in the Decided lines (SC2, QS1, AR3, and so on) are rulings recorded in `docs/j5/worklog/` or in the dogfood v0 plan (removed on 2026-09-29; it's in git history). Numbered decisions dated 2026-09-24 were made during that day's upstream advance.

### Agents and orchestration

#### D1. Help is a Subagent, a Peer Agent, or a Crew

**Upstream:** the instructions every agent receives point it to `delegate_task` for cross-provider help, and to `t3_thread_launch` or `create_threads` to start new threads.

**J5:** agents are told about three shapes of help: a Subagent their own provider runs, a Peer Agent started with `spawn_agent`, and a Crew proposed with `propose_crew`. `delegate_task` is kept for two narrow cases: running a saved persona as a subagent, and cross-provider work the person doesn't need to talk to directly.

**Why:** upstream's delegated child is "a Peer Agent in a Subagent costume": the person can't talk to it, yet it outlives the agent that started it. That is the awkward middle J5's vocabulary exists to remove. The Crew shape was added after an agent asked to "spawn a crew" made subagents instead, because nothing it had been told mentioned a Crew. Personas later gave `delegate_task` a purpose again: a persona needs a way to run as a subagent.

**Consequences:** upstream's launch and workspace guidance never reaches J5 agents. `spawn_agent` and Crew seats require their own workspace choice instead, with upstream's `existing_worktree` name and shape beside `shared` and `worktree`, and reuse upstream's ThreadLaunch to prepare a new worktree (#274). The instructions file is also edited for playbooks and personas, so every upstream advance merges upstream's prompt changes by hand, and a test pins J5's wording.

**Decided:** Jackson with Product, 2026-08-24 (ST1–ST5); the Crew shape on 2026-09-17; the persona route in Jackson's review of 2026-09-13, which partly reverses ST5. Whether `delegate_task` stays at all is under discussion (#336). Recorded in FORK.md case 8 and the saved-agent mentions section.

#### D2. Agents see a fail-closed subset of upstream's MCP tools

**Upstream:** agents can send into another thread, interrupt it, wait on it, launch threads, and create threads in bulk.

**J5:** those tools are hidden from agents. J5 keeps the upstream tools it has admitted, rewrites the descriptions that would mislead J5 agents, and hides any new upstream tool until someone reviews it.

**Why:** J5 built its own versions of these tools, integrated with J5's model: `send_message` and Exchanges instead of raw send, `stop_agent` instead of interrupt, and `spawn_agent` and `propose_crew` instead of launch. Upstream's tools were more primitive and didn't meet J5's needs when this was decided. A raw send is communication the Squadron ledger can't see, so a reply that never comes stalls silently. Raw thread creation skips the Squadron home a spawn records. Hiding new upstream tools by default means each one is reviewed against J5's definitions before agents get it. The tools are hidden, not deleted, to keep the fork's edits small.

**Consequences:** upstream's toolkit stays compiled but unused. Upstream's tools keep evolving, so J5 should periodically re-evaluate them and consider merging its tools with upstream's rather than carrying parallel versions. Each advance checks the admitted tool list, which a test pins, and re-reads upstream's descriptions. Open gaps: `t3_worktree_handoff` still points agents at a tool they can't use. `t3_pending_request_respond` answers another thread's pending approval or question without J5's authority checks (#345).

**Decided:** Jackson, 2026-08-29 (substrate session). Omitting bulk creation was a Director disposition (an agent role), 2026-08-31. Withdrawing `t3_thread_wait` was Bryant's decision, 2026-09-14. `delegate_task` returned after Jackson's review of 2026-09-13. Recorded in FORK.md cases 2, 4 and 38.

#### D3. J5's tools are pre-approved on Codex and Claude only

**Upstream:** on Claude, upstream pre-approves all of T3's own MCP tools, except in a read-only sandbox, where only its read-only tools are allowed. Codex refuses every non-read-only MCP tool under approval policy `never`, which is the policy full-access mode sends.

**J5:** on Codex, J5 approves its own coordination tools one at a time, Playbook tools included. On Claude, it adds them to the read-only allowance. On every other harness, the provider may show its own MCP prompt once before the Crew roster card, and a read-only persona there can't propose a Crew.

**Why:** without the Codex approvals, `send_message`, `spawn_agent` and `propose_crew` all fail in full-access mode. The approvals are per tool, never server-wide, so worktree handoff, preview and scheduling keep Codex's own verdict. Making other harnesses skip their native prompt is adapter work, and adapters are upstream's. ACP has no trustworthy server identity in its permission request, and Cursor's SDK doesn't expose MCP approval at all. A read-only persona being blocked from proposing is acceptable, because proposing a Crew is enough of a write.

**Consequences:** every advance must keep the Codex and Claude additions and their exact-list tests. A general fix belongs upstream (#276). Crews AC5 must say the roster card is the only human step on Codex and Claude, not on every harness.

**Decided:** Bryant built the approvals, 2026-09-10 to 2026-09-15. Jackson's ruling of 2026-09-26 (#233) kept them and limited them to Codex and Claude; Bryant accepted it by narrowing and merging #301 and closing #233 on 2026-09-29. Recorded in FORK.md's saved-agent mentions section.

#### D4. Agent deliveries queue behind a running turn; Astra peers can steer

**Upstream:** a message sent to a busy thread steers the running turn when it can.

**J5:** a message from one agent to another waits until the receiver's turn ends. The exception is peer updates to a running Codex Astra turn, which arrive as steers.

**Why:** a peer owns nothing about another agent's turn, and upstream's steering was actively harmful. On Claude, a steer aborts the turn and makes the agent report that "the user doesn't want to take this action", a refusal the human never gave. On Cursor, it destroys the turn. The ruling expected this to fold back into upstream: J5 only changed the default value of upstream's own delivery setting, so that it would collapse if upstream shipped a queue option. Astra is built to take messages during work. Without the exception, a 36-minute Astra run worked from stale guidance because its peers' updates waited for the end.

**Consequences:** this changes when a message is admitted, not whether the model reads it. Queueing also removed an accidental way of freeing a stuck start, so a queued run's age became something the Fleet page shows. Each advance checks the outbox and follow-up behavior this depends on. Checked on 2026-09-28 against upstream's V2 branch, it is still needed: upstream still steers whenever it can (Claude with `priority: "now"`, which cancels sibling tool calls), and has no Astra-specific or asynchronous delivery. **J5 wants to drop this divergence** and follow upstream's delivery once upstream can deliver a message to a running turn without aborting it (Claude) or restarting it (Cursor), and supports Astra's in-work messaging. Once the committed-Stop patch is removed (D5), a stopped Astra agent can occasionally be woken by a peer steer that was already in flight; the person stops it again.

**Decided:** Jackson with Product, 2026-09-03 (QS1); the Astra exception by Jackson, 2026-09-04. Recorded in FORK.md case 26.

#### D6. Native resume starts fresh only when the conversation is gone

**Upstream:** when resuming a provider conversation fails for any reason, V2 starts a new one, primed with a summary.

**J5:** a new conversation starts only when the provider reports the old one is gone, and the thread says so visibly. Any other resume failure is a visible error. The one other fresh start is deliberate: when an earlier history delivery to the provider is uncertain, J5 skips resume and starts fresh rather than risk a duplicated or half-applied history.

**Why:** a provider's native history can't be rebuilt from the app's transcript. A silent fresh start hands the agent a stranger's memory without anyone noticing. That happened once, after a Codex schema change, and the transfer recorded no error.

**Consequences:** each adapter has to report "conversation gone" for this to work: Codex and OpenCode do, Claude resumes lazily, and ACP and Pi never report it. Upstream appears to intend the fresh start, so the change offered back upstream (#276) has to argue for it. If upstream declines, the fallback position is a visible fresh start. Checked on 2026-09-28, it is still needed: V2 still starts fresh on any resume failure without telling the person, and upstream's recent changes reinforce that behavior. **J5 wants to drop this patch** as soon as upstream starts fresh only when the provider reports the conversation is gone, and tells the person when it does; the give-back in #276 argues for exactly that.

**Decided:** Jackson, 2026-09-24 (#8), narrowing an earlier refuse-everything rule from 2026-09-04. Recorded in FORK.md's temporary patches.

#### D7. Codex CLI version floor

**Upstream:** no minimum Codex version.

**J5:** Codex CLIs older than 0.151.0 are refused with a named error.

**Why:** older CLIs omit fields the schema requires. Their responses fail to decode and degrade into silent fallbacks, such as a silent fresh start (D6).

**Consequences:** the floor itself is unproven, because the test fixtures don't prove compatibility with a real 0.151.0. It is revalidated at every schema regeneration.

**Decided:** introduced in PR #92 (2026-09-04); Jackson approved it on 2026-09-28. The floor value itself is still unproven. Recorded in FORK.md case 28.

### Squadrons and the sidebar

#### D8. The Squadron replaces the project as the unit of choice

**Upstream:** the user picks a folder, which becomes a project, everywhere: new threads, Add Project, sidebar filters, the new-thread headline, and the folder line on each thread card.

**J5:** the Squadron takes the project's place wherever the person chooses or reads what a thread belongs to:

- Every new-thread door asks for a Squadron, and a draft without one can't send.
- Add Project opens Create Squadron.
- The new-thread headline reads "What should we build in ⟨Squadron⟩?", and the placeholder asks the person to choose a Squadron.
- The sidebar scopes by Squadron instead of filtering by project. Thread cards name the project, as upstream does.
- The clone notice's "Open project" action is gone.
- Archiving or unarchiving another agent that has a Squadron home also requires the caller to belong to that Squadron, on top of upstream's same-project rule.
- Merge-back is refused unless both threads share a Squadron home, or both have none.

**Why:** upstream's model is one folder, one project. Work isn't shaped like that: many efforts touch one repository, and one effort touches several. The Squadron is what the person chooses between. Reusing the project flow with a new name would rebuild the one-to-one shape the Squadron exists to replace. Upstream scopes an agent's actions on other threads to its project; J5 keeps that and adds a Squadron check on top, so a shared Squadron never reaches across projects. This doesn't limit communication: any agent can still message any other.

**Consequences:** a Squadron has one folder for now. Many small seams in upstream UI must be re-checked at every advance, and each case lists its own check. J5 replaces upstream's whole headline component; a smaller J5-owned headline at the same mount would be cheaper to carry. Merge-back hasn't been exercised live. Open gaps: the scheduling selector (#38), the legacy sidebar door (#39), and project nouns still left in some upstream copy.

**Decided:** Jackson, 2026-08-24 (SC2, SC3), 2026-08-29 (SB3), 2026-08-31 (E7), 2026-09-01 (#47, cards), 2026-09-12 (cross-environment drafts), 2026-09-24 (sidebar scope), 2026-09-25 (clone notice), and 2026-09-28 (the organize check and merge-back limit, which arrived without a ruling in the 2026-09-17 integration). Recorded in FORK.md cases 9, 10, 13, 15b, 16–20, 23, 34 and 38, and its root-spawn section.

#### D9. First run creates a Squadron

**Upstream:** a first run lands in a draft.

**J5:** the person creates a named Squadron, with its folder, before the first thread. The server no longer requires that: a thread launched without a Squadron registers into its project's Squadron, and when the project has none the server creates one named after the project. When several Squadrons reference the project, the launch is refused.

**Why:** an unnamed default becomes a junk drawer that defeats the concept. Agents need a home, and the gate says so. The server rule is the first step of retiring Squadrons into projects ([#412](https://github.com/Jacksondr5/j5code/issues/412)), where a thread's home is its project. A Squadron created this way carries its project's name, so it isn't the unnamed default the gate guards against.

**Consequences:** because a folder is required, a Squadron with no repository isn't possible. That rules out a real future use: non-coding work such as a support rotation. A failed read offers only a retry, never a guessed home. The web client still sends a Squadron with every launch, so the gate is what a person sees until the client's new-thread doors return to upstream. Until then the server rule is reached only by launches that send none, such as ACP session import.

**Decided:** Jackson, 2026-08-24 (SC2); the folder requirement from DV2 (2026-08-25) and the Squadron definition (2026-09-05). The server rule: Jackson, 2026-10-03, in the plan to retire Squadrons. Recorded in FORK.md cases 9 and 10.

#### D10. Welcome wizard assigns imported conversations a Squadron

**Upstream:** the welcome wizard imports conversations into projects.

**J5:** a fourth stage gives each imported folder's conversations a Squadron home.

**Why:** upstream's wizard imports conversations into projects, and J5 threads need a Squadron home (D8). The stage gives imported conversations one from the start.

**Consequences:** native desktop and remote onboarding weren't exercised. An archive can race the assignment (#179).

**Decided:** Jackson, during the 2026-09-17 upstream integration (PR #178), confirmed 2026-09-28. Recorded in FORK.md case 39.

#### D11. A scheduled task can't start a thread in a project that several Squadrons share

**Upstream:** a scheduled task can be created two ways. An agent schedules work for its own thread, or the person creates one in Settings → Automations, and each fire starts a fresh thread.

**J5:** both work. A fresh thread joins its project's Squadron, which the server creates when the project has none. When several Squadrons reference the project, the run is refused before a thread is created, and the task records a visible failure that names the project.

**Why:** a new thread needs a Squadron home, and its project now supplies one. A task carries nothing that chooses between several Squadrons on one project, and picking one would invent a home. Refusing before the thread exists keeps a recurring task from leaving a homeless thread behind on every fire.

**Consequences:** a task in a shared project fails each time it fires until it is bound to a thread or the project is left with one Squadron. This entry retires when Squadrons fold into projects ([#412](https://github.com/Jacksondr5/j5code/issues/412)).

**Decided:** DV5, dated 2026-08-31 in the dogfood v0 overrides, refused every such run. Jackson, 2026-09-28: a gap to fill. Narrowed to shared projects on 2026-10-03, in the plan to retire Squadrons. Recorded in FORK.md case 12.

#### D12. Multi-model send carries the Squadron

**Upstream:** a draft can fan out to several models, each in its own thread.

**J5:** each thread gets the draft's Squadron, and fanning out is refused from a persona draft.

**Why:** the person chose a Squadron for the draft, so every thread it fans out to belongs there. A thread sent without one would join its project's Squadron instead, which need not be the one chosen, and is refused when several Squadrons share the project. A persona pins one model, so fanning it out would run every thread on that same model.

**Consequences:** each advance checks that every fan-out path sends the draft's Squadron.

**Decided:** 2026-09-24 (#7b), a merge-time decision made to let that day's advance proceed. How fan-out should really work in J5 is open (#338). Recorded in FORK.md case 19.

### Archive and lifecycle

#### D13. Archive warns with measured facts

**Upstream:** archiving asks for confirmation only if the person turned that setting on, and the confirmation is generic.

**J5:** when archiving would strand something, such as open asks, running work or Crews, the web dialog lists it, whatever that setting says. A failed read says "Couldn't check". A Crew seat can't be archived on its own from any door.

**Why:** archiving is where obligations get stranded, and cleanup that happens silently is how a fleet loses track of itself. The platform's job is to put the facts in front of whoever decides. Crews archive as a unit: a member's failure is usually recoverable by messaging it again, and a member that can't be recovered has probably contaminated its crewmates.

**Consequences:** the lone-seat refusal is on the server, so it covers every client, but it lets the archive through if the Crew store can't be read.

**Decided:** Jackson, 2026-08-29 (AR2, AR3); the Crew unit rule, Jackson with Product, 2026-08-21 (R14); the server-side seat refusal from Jackson's review of 2026-09-17. Recorded in FORK.md cases 21, 22 and 37.

#### D14. A Crew follows its Captain

**Upstream:** archive, unarchive, settle and unsettle each touch one thread.

**J5:** archiving or deleting a Captain retires its live Crews. Unarchiving it brings back the Crews that retired with it. Settling it settles its seats, except those upstream's own auto-settle would leave alone because they're still working or waiting on the person. Unsettling it unsettles the seats that were settled.

**Why:** a Crew without its Captain has no one to report to, and the interface would need a place to show it. Before archive cascaded, sidebar archives of Captains stranded sixteen seats. Settle keeps upstream's meaning: a finished run is not a settled seat, but a settled Captain carries its seats with it.

**Consequences:** a Crew restore that stops partway is repaired by hand, by archiving and unarchiving the Captain again. Unarchiving doesn't bring back interrupted runs or dropped Exchanges. Snooze doesn't cascade.

**Decided:** archive and delete follow the Crew unit rule (R14) and were built on 2026-09-15. Jackson ratified the rest on 2026-09-26 (#312). Recorded in FORK.md case 21.

#### D15. Archive Undo is withheld when Crews may retire

**Upstream:** every archive offers Undo.

**J5:** Undo is hidden when the archive may retire a Captain's Crews, including when it can't tell.

**Why:** Undo would bring the Captain back without its Crews, so a one-keystroke Undo would quietly break the Crew.

**Consequences:** this retires when unarchiving a Captain restores its Crews (D14). That code exists on the Crews stack (#315): with it, Undo, which unarchives the Captain, brings the Crews back too, and #315 removes this suppression so upstream's Undo returns unchanged. It depends on #315's fix for re-archiving after an Undo, which otherwise reuses the first archive's command IDs and leaves the Crew live.

**Decided:** Jackson, 2026-09-24 (#7d). Recorded in FORK.md case 21.

### Timeline, composer, and plans

#### D16. Agent-to-agent messages render as cards

**Upstream:** a message delivered from another agent appears as if the person had typed it, with only a raw envelope tag to tell it apart.

**J5:** incoming and outgoing agent messages render as cards, as prominent as a user message, naming the sender and linking to its thread. They stay out of the conversation minimap, and queued rows name their sender.

**Why:** the person is a first-class reader of every agent-to-agent message and should see it in the normal flow without hunting. A first, quieter design made the messages hard to spot, so they were made prominent. The minimap tracks the person's own prompts, and agent messages there were noise.

**Consequences:** the seams in the timeline are small, but each advance checks the row and minimap hooks. Sent-message cards recognize only Codex and Claude tool records; other providers keep generic rendering. Upstream is still building out its own agent-to-agent features (see the [upstream convergence watchlist](upstream-convergence.md)), so its treatment of these messages may change. Check this entry at every upstream advance, and prefer upstream's treatment if it now meets the need.

**Decided:** Jackson, 2026-08-29 (TA1–TA5) and 2026-08-31 (TA6–TA8, including cards for sent messages). The minimap rule is from Jackson's PR #168 (2026-09-16). Sender labels on queued rows came from Jackson's dogfood findings (#42, #62), fixed on 2026-09-04. Recorded in FORK.md cases 7, 14 and 24.

#### D17. Plans are stored as artifacts and exported to `plan.md`

**Upstream:** a plan lives inline in the thread, with a download button.

**J5:** finalized plans are stored as project artifacts, and the latest is exported to `artifacts/plan.md`.

**Why:** plans were easy to lose in chat, couldn't be shared between agents, and a folder in the repository needed Git exclusions and could collide with tracked files.

**Consequences:** each finalized plan overwrites the project's one `plan.md`. The path form is undecided.

**Decided:** Tyler, who owns it, in PR #109 (2026-09-05); Jackson approved it on 2026-09-28. Recorded in FORK.md case 33.

#### D18. `@` offers saved personas first, and persona threads pin their model

**Upstream:** typing `@` in the composer opens a picker for referencing context in the message: files in the workspace and, in V2, other threads. Below the text box, the composer has a row of controls for the thread: the model picker (for example "Claude Opus 5.5"), reasoning effort, access mode (for example "Supervised"), and plan mode.

**J5:** `@` also lists saved personas, first, and picking one runs that persona. In a persona's thread, that whole row of controls is replaced by a chip naming the persona, because the persona fixes its own model, effort, and access, and the server rejects any change.

**Why:** Jackson typed `@scout` expecting a persona and got files (2026-09-13); Bryant made the picker list saved personas (2026-09-14). A persona's route is fixed and enforced by the server, so a thread's model picker would only produce failed sends. No reason is recorded for listing personas ahead of threads.

**Consequences:** the `@` menu and the controls row are edits to upstream's composer, one small addition per client. Each advance checks upstream's mention ordering and its composer controls, and personas route only to Codex and Claude.

**Decided:** the persona picker is Bryant's request (2026-09-08) and fix (2026-09-14). The persona model lock comes from Bryant's persona stack, whose scope was approved on 2026-09-08. The ordering against threads arrived in the 2026-09-24 advance (PR #262). Jackson approved it on 2026-09-28. Recorded in FORK.md's saved-agent mentions section and its PR #75–#86 table.

### Storage, install, and identity

#### D19. J5 never shares on-disk state with T3 Code

**Upstream:** T3 Code keeps its data in `~/.t3`, reads `T3CODE_HOME`, and uses a `.t3` folder in worktrees.

**J5:** it uses `~/.j5code`, `J5CODE_HOME`, and `.j5code`, with no fallback to T3's. J5 has its own desktop profiles, and refuses to open T3's databases. Its app ID (`codes.jackson.j5code`), URL scheme (`j5code`), CLI command (`j5`), and update URLs are its own.

**Why:** J5 and T3 Code must be able to run side by side on one machine without either reading or damaging the other's data, or taking the other's deep links, updates, or system registrations. Nothing in J5 points at upstream's infrastructure.

**Consequences:** some Linux integrations still collide with an installed T3 Code (#138), and many `T3CODE_*` variable names remain. One exception remains, to be removed: SSH transport still writes `~/.t3/ssh-launch` on remote hosts, kept only for npm-era remote servers that no longer exist (#339). Whether to rename the remaining `T3CODE_*` variables is open (#340). Each advance checks for new upstream reads of `T3CODE_HOME` or `.t3` paths, and re-checks the database migration bridge.

**Decided:** Jackson, 2026-08-30 (DQ5, recorded on #33), 2026-09-02 (#68), and 2026-09-24 (#1, #4). The identifiers were settled in the fork setup plan (2026-08-15) and confirmed by Jackson on 2026-09-28. Recorded in FORK.md cases 15, 25, 31 and 41, and in `BRANDING.md`.

#### D20. J5 installs from its own release archives

**Upstream:** V2 ships self-contained release archives from upstream's own repository.

**J5:** J5 builds the same kind of archive from `Jacksondr5/j5code`, installs a `j5` command, and runs as `j5code.service` (`codes.jackson.j5code.service` on macOS). It hands over from the npm-era service only when that service is J5's.

**Why:** J5 followed upstream from npm to archives rather than keep npm alone. It publishes from its own repository so it never installs or updates T3 Code, and it renames the service so both can be installed at once.

**Consequences:** only darwin-arm64 and linux-x64 get releases, where upstream ships five platforms, and no reason for that is recorded. Other hosts build from source and get no `j5 update` or service. A real service handover, signing and notarization weren't verified when this shipped. Migration steps are in `docs/user/migrating-to-release-archives.md`. Windows releases are wanted (#341).

**Decided:** Jackson, 2026-09-24 (#3, #3a). Recorded in FORK.md cases 40 and 41.

#### D26. `j5 triage` investigates and files against J5's repository

**Upstream:** `triage` hands a misbehaving install to the person's coding agent with a playbook that clones `pingdotgg/t3code` at the installed version, searches and files issues there, and replaces itself with the copy on upstream's `main` when the two differ.

**J5:** the playbook clones, searches and files on `Jacksondr5/j5code`, refreshes from `j5/main`, and names the product J5 Code.

**Why:** J5's release tags don't exist upstream, so diagnosis ran against the wrong source, and J5-only problems would have been filed in upstream's tracker.

**Consequences:** `triagePrompt.ts`, `.github/triage/PLAYBOOK.md` and the `via-triage` issue template are edited in place, so each upstream advance merges upstream's playbook changes by hand. The repository needs the `via-triage` label. Releases installed before this change keep upstream's playbook.

**Decided:** Jackson, 2026-10-04, PR #446. Recorded in `BRANDING.md`.

#### D27. Usage telemetry reports to J5's PostHog project

**Upstream:** the server sends product usage events to upstream's PostHog project by default, and `T3CODE_TELEMETRY_ENABLED=false` turns them off.

**J5:** the same events, identifier and opt-out, sent to a PostHog project Jackson owns.

**Why:** J5 servers were reporting their users' usage to T3 Tools, which J5 has no agreement with and whose data Jackson can't see or delete. He wants the usage data himself, and J5's privacy page has to name who receives it.

**Consequences:** one default in `AnalyticsService.ts` differs, so each upstream advance checks the token is still J5's. Jackson is responsible for the data: the project discards client IP addresses, and J5's privacy page describes what is sent. Releases installed before this change keep reporting to upstream's project. There is no Settings toggle, only the environment variable.

**Decided:** Jackson, 2026-10-04. Recorded in `BRANDING.md`.

#### D21. Pair discovery stays inside a worktree

**Upstream:** `pair` is the CLI command that mints a one-time link for connecting a browser or the mobile app to a running server. When it finds no server in the current worktree, it falls back to the default install.

**J5:** in a linked worktree with no running server, `pair` refuses to fall back.

**Why:** during a dogfood test, an agent ran `pair` in its worktree before its server was up, and the fallback minted a real pairing token against the live install (#70). The isolation work (D19) exists so an isolated environment can never reach shared state by accident. A short bounded retry covers a server that hasn't finished starting (#67).

**Consequences:** the retry can be dropped if upstream gives the CLI a way to tell a server that is starting from one that isn't there. Each advance checks `pair`'s home resolution.

**Decided:** introduced in PR #94 (2026-09-04). Jackson approved it on 2026-09-28, closing the carry-or-drop question FORK.md's 2026-09-06 review left open. Recorded in FORK.md's final upstream-file review ("Pair discovery isolation and activation retry") and its `pair.ts` rows.

#### D25. The product is named J5 Code wherever a person or an agent reads it

**Upstream:** the app, its CLI output, error messages, agent instructions and tool titles say "T3 Code", tool rows and the mobile header show the T3 mark, and new worktree branches start with `t3code/`.

**J5:** all of that says "J5 Code" and shows the J5 mark, and new branches start with `j5code/`. Upstream's own services keep their names ("T3 Connect", "T3 Account"), as do protocol identifiers such as the `t3-code` MCP server. Documentation keeps upstream's wording.

**Why:** J5 and T3 Code can be installed side by side, and a person should always be able to tell which one they are looking at. The old name kept reappearing because the branding rules left general copy alone.

**Consequences:** these are literal edits in roughly 230 upstream files, so every upstream advance has to rebrand the strings upstream added or changed; the grep is in [Merging upstream](../process/upstream-merge.md) and `BRANDING.md` lists what stays. Temporary branches created under `t3code/` are still recognized.

**Decided:** Jackson, 2026-10-04, PR #445. Recorded in `BRANDING.md`.

#### D28. The `j5` command

**Upstream:**

- **The executable.** Each release archive's executable is `t3`, and the `t3` command on `PATH` links to it.
- **Updates.** Only `t3 update` moves that link. An update from the app leaves the command on the old version.
- **`PATH`.** When the link's directory isn't on `PATH`, the installer prints a line for the person to add.
- **Agents.** Agents and terminals inherit the server's `PATH`, which has `t3` only if the person's shell provides it.
- **The desktop app.** It installs no command, and its agents have `t3` only if the person's shell provides it.

**J5:**

- **The executable is `j5`.** The command, the file it runs, and the process are all `j5`. Archive file names keep upstream's `t3-<version>-<platform>` names.
- **Existing servers are moved once, by hand.** The rename is launcher protocol 4. A server from before it is refused the update from the app with a message to run `j5 update` on its machine; that command installs the new version and replaces the service's launcher. Each archive carries a `t3` link to `j5` so those servers can run that check and that command.
- **The command follows the service.** When the background service's server starts as the committed version, after an update or any restart, it repoints the installer's `~/.local/bin/j5` at itself.
- **The installer puts it on `PATH`.** When `~/.local/bin` isn't on `PATH`, the installer adds one marked line to the shell's startup file (zsh, bash, or fish) that puts the directory last, and `j5 uninstall` removes it. A profile it can't write gets the printed hint instead, and `J5CODE_NO_MODIFY_PATH` skips the edit.
- **Agents get the server's own `j5`.** A release server keeps `<home>/bin/j5` pointed at itself, and every server that finds a `j5` there puts `<home>/bin` first on the `PATH` its agents and terminals inherit.
- **The Mac app gives its agents `j5` too.** At every launch it writes a script that runs its bundled CLI to `<home>/bin/j5`, which its server then puts first for its agents. It leaves the person's own `PATH` and shell startup files alone unless they ask: a command in the palette, "Install 'j5' command in PATH", links `~/.local/bin/j5` to that script and adds the installer's line when needed, and a matching command undoes it.

**Why:**

- **The name.** J5 shouldn't point at `t3` at all. With the old name, `~/.local/bin/j5` ran a file called `t3` and the server showed up as `t3`, which is confusing next to an installed T3 Code. Archive names stay, because existing servers download updates by those names and people never see them.
- **The one-time step.** An update from the app never replaces the service's launcher, and an old launcher starts every new version as `t3`. Shipping a `t3` link indefinitely would leave the migration unfinished, and removing it later would break those servers. Refusing the update with a clear message moves each server and its launcher across together.
- **Following updates.** On the dogfood box the command ran 0.0.44 while the service ran 0.0.47, so agents called a CLI three versions behind their server (#398). Upstream has the same gap with `t3`; the fix is in the give-back backlog (#276).
- **The installer and `PATH`.** A stock macOS shell doesn't have `~/.local/bin` on `PATH`, so a fresh install's `j5` wasn't found until the person edited their profile (#397). Jackson chose a profile line over linking into `/usr/local/bin`, which needs an admin prompt and a root-owned file the server couldn't repoint.
- **Agents.** An agent that can't find `j5` tends to work around it without saying so. Giving every agent its server's CLI, whatever the person's shell setup, removes that failure. The directory is J5's own and holds only `j5`, so it can go first without shadowing anything, including an installed T3 Code's `t3`.
- **The Mac app.** Most desktop apps never edit shell startup files; the few that do have a record of bugs from it. Agents were the actual problem, and they don't need the person's shell changed. The person's own terminal gets `j5` from a command they run, as VS Code offers for `code`.

**Consequences:**

- **One visit per existing server.** Each server on 0.0.47 or earlier needs `j5 update` run on its machine. It keeps running its old version until then.
- **The launcher reads protocol-3 state files.** The old CLI's `j5 update` writes one before starting the new launcher. This is a second line in upstream's `serviceProtocol.ts`.
- **The `t3` link is temporary.** Removing it is tracked in #440. After that, a server still on 0.0.47 or earlier gets a generic install error and needs the installer and `j5 service install`.
- **No downgrade across the rename.** Downgrading below the rename with `j5 update --allow-downgrade` isn't supported.
- **Only the default link is repointed.** The repoint covers only the installer's default link, `~/.local/bin/j5`, and only when it already points into the home's runtime. A link placed elsewhere stays where it is.
- **One `j5` per home for agents.** If two servers share a home, the last one started owns `<home>/bin/j5`.
- **`j5 service status` asks for a repair after an update from the app.** The service's unit still names the launcher it was installed with, and the now-current `j5` reports that as needing `j5 service install`. That is accurate: running it replaces the launcher, with a restart. An agent that follows the suggestion restarts its own server. Keeping the launcher current is a separate improvement.
- **`j5 uninstall` removes the `PATH` line only with its command.** The installer's link and its line go when the link belongs to the home being uninstalled, so uninstalling another home, such as an agent's scratch home, leaves them.
- **A terminal can still find another `j5` first.** The directory is first for what the server starts directly. A shell that re-reads the person's profile can put their own directories, and a `j5` in them, ahead again.
- **At each advance:** check new upstream code that locates the executable by name, upstream's `SERVICE_LAUNCHER_PROTOCOL` (J5's number must stay above it), and that the startup hook still runs after `prepareTrial`.

**Decided:** Jackson, 2026-10-02 (#403), 2026-10-03 (the protocol bump and the `j5 update` step; #398; #397, including leaving the person's `PATH` alone in the Mac app) and 2026-10-04 (#441, in the command palette only). Recorded in FORK.md cases 50 to 55.

### Awaiting a decision

These already diverge on `j5/main`, but no human ruling is on record. Each landed as an implementer's call inside a merged PR. The person rules on each one; an approved entry moves up into its section, and a rejected one becomes a fix.

#### D22. Agent-spawned threads move under their spawner in the sidebar

**Upstream:** every thread except provider subagents appears in the sidebar.

**J5:** an agent-spawned Peer Agent, Crew seats included, leaves the top level of the sidebar unless pinned, and appears in the expander under the agent that spawned it.

**Why:** once agents spawn agents, a flat list stops telling the truth about what is running (Bryant, #205).

**Consequences:** this differs from the Fleet page definition (AC3: nothing is hidden from the sidebar because of how it was created), though the agent stays one click away in the expander rather than hidden. Jackson set aside the original rule (SB5) on 2026-09-04, because he has the Director spawn most of the agents he talks to. The Crews definition hides only Crew members. Pinning a spawned agent from its own thread brings it back to the top level.

**Status:** reintroduced in PR #149 (Bryant), approved in review on 2026-09-21 without a ruling on this point. Depends on the human-contact spectrum discussion (#336): which agents belong in the sidebar follows from where they sit on that spectrum.

### To be removed

The person ruled against these. They still diverge on `j5/main` until their fix lands, and then move to Retired.

#### D5. A committed Stop wins over a racing steer

**Upstream:** a steer the provider accepted before the person pressed Stop can come back as a follow-up turn after it. Upstream lists this as unfinished (`TODO(interrupt-hardening)`).

**J5:** once a Stop is committed, a steer accepted before it doesn't start a new turn.

**Why:** J5 agents message Astra peers as steers (D4), so a peer's steer that the provider accepted just before the person pressed Stop can wake the agent they stopped. Other agent messages queue rather than steer, and upstream's Stop-holds-the-queue change covers those.

**Consequences:** only an Astra peer's steer still in flight at the moment of Stop is affected; if a stopped agent wakes, the person stops it again. Upstream tracks the underlying gap as `TODO(interrupt-hardening)`.

**Status:** it arrived with the 2026-09-17 upstream integration without a ruling, and Jackson kept it on 2026-09-24 (#5). Jackson, 2026-09-28: controlling a thread's turns is upstream's area and this is a race J5 doesn't design for, so follow upstream's implementation. To be removed (#343). Recorded in FORK.md's temporary patches.

#### D23. A committed Stop also blocks usage-limit auto-resume

**Upstream:** when a run fails because the provider's usage limit was hit, it resumes automatically once the limit resets. Upstream checks only that the run failed on a usage limit.

**J5:** it also checks whether the person pressed Stop on that run first. The case this covers: the person presses Stop, but before the provider acknowledges it, the provider hits its usage limit, so the run ends as "failed: usage limit" rather than "stopped". Upstream would then resume the run hours later, restarting an agent the person deliberately stopped. J5 doesn't resume it.

**Why:** it extends D5: a Stop the person committed wins over anything automatic that would revive the run. No separate reason is recorded.

**Status:** added during the 2026-09-24 advance (PR #262), without its own decision. Jackson, 2026-09-28: an edge case J5 doesn't design for, so follow upstream. To be removed (#343).

#### D24. Astra model aliases

**Upstream:** no short aliases for `gpt-6-astra`.

**J5:** `astra`, `gpt-6` and `6` resolve to `gpt-6-astra`.

**Why:** to mirror the Fable aliases that existed at the time, which upstream has since removed.

**Consequences:** D4's Astra exception checks the resolved name, so removing the aliases needs checking against it.

**Status:** introduced in PR #101 (2026-09-04), merged on the Director's authority. To be removed in favor of upstream (#342). Recorded in FORK.md case 32.

### Retired

None yet.

## History

- 2026-09-26 — created: the three zones, the decision protocol, and the register, seeded from FORK.md and the worklog records (Jackson, [#327](https://github.com/Jacksondr5/j5code/issues/327)).
- 2026-10-04 — D25 added: user-visible copy, marks and branch names (PR #445).
- 2026-10-04 — D26 added: `j5 triage` points at J5's repository (PR #446).
- 2026-10-04 — D28 added: the `j5` command (PR #414).
