---
title: "J5 and upstream — the three zones, and the register of divergences"
kind: definition
---

# J5 and upstream

J5 Code is a fork of T3 Code, and it stays one. Upstream builds the base product and J5 builds a fleet layer on top ([overview](overview.md)). The fork is only affordable if J5 keeps its changes to upstream few, deliberate, and recorded, because every change is carried through every upstream advance. The principle is [upstream owns its product](principles.md#upstream-owns-its-product).

## The three zones

Every change lands in one of three zones.

1. **J5's domain.** The areas in the [overview](overview.md), built in J5-owned code. J5's definitions and principles govern them.
2. **Code overlap.** J5 code has to be reached from, or placed inside, a file upstream owns, without changing what upstream's product does. This is a matter of process, and [`FORK.md`](../../../FORK.md) is the whole answer: put the J5 code in J5-owned files, keep the upstream edit to a small appended integration case, and record the case in the same PR.
3. **Product overlap.** A change to what upstream's product does, as a user or agent experiences it: overriding or suppressing upstream behavior, giving an upstream concept a different meaning, or extending an upstream area such as a provider adapter so that it serves a J5 feature. This is the person's decision.

The test for zone 3 is behavioral, not about code size. A one-line edit that makes an upstream control disappear is zone 3; a large J5 module reached through a one-line registry entry is zone 2.

## Deciding a product overlap

An agent that finds its work heading into zone 3 stops and brings the person:

- **what upstream does today**, and why, if upstream says;
- **what J5 would do instead**;
- **the trade-offs**: what the person gains, what it costs to carry through upstream advances, and what breaks if upstream later changes the same area;
- **the alternatives**, which always include following upstream and saying "not supported here".

The default is to follow upstream. Where upstream's product is less capable than a J5 feature wants, the usual answer is that the J5 feature is not supported there, and a general fix is offered back upstream (tracked in the give-back backlog, [#276](https://github.com/Jacksondr5/j5code/issues/276)).

When the person approves a divergence, it is recorded below and its code gets its FORK.md cases. When the person declines, nothing is recorded here; the ruling lives on the issue or PR where it was made.

## The register of divergences

Every place J5 knowingly makes upstream's product behave differently, with the person's decision behind it. FORK.md is the code-level ledger; this is the product-level one. An entry leaves the register when upstream makes it unnecessary or J5 stops needing it, and its History line says so.

Each entry says what upstream does, what J5 does instead, who decided and when, what it costs, and where the code is recorded. Rulings with letter codes (SC2, QS1, AR2) are from the design-session records in `worklog/`; numbered 2026-09-24 decisions are from the V2 upstream advance.

### Agents and orchestration

- **Help is a Subagent, a Peer Agent, or a Crew.** Upstream steers agents to `delegate_task`, `t3_thread_launch`, and `create_threads`. J5 steers them to a provider-native Subagent, `spawn_agent`, or `propose_crew`, and routes a persona mention to `delegate_task`. Decided: Jackson, 2026-08-24 (ST5); the Crew shape 2026-09-17; the persona route 2026-09-14. Cost: upstream's launch and workspace guidance doesn't reach agents. FORK.md case 8.
- **Agents see a fail-closed subset of upstream's MCP tools.** Upstream exposes send, interrupt, wait, launch, and `create_threads`. J5 omits them, re-declares the tools it keeps with J5 wording, and keeps any new upstream tool hidden until someone admits it. Decided: Jackson, 2026-08-29 (substrate session); `delegate_task` re-admitted 2026-09-14. Cost: upstream's toolkit stays compiled but unused, and new upstream tool descriptions need checking each advance. FORK.md cases 2, 4, 38.
- **J5's tools are pre-approved on Codex and Claude only.** Upstream pre-approves only its read-only tools on Claude, and Codex refuses non-read-only MCP tools under approval policy `never`. J5 pre-approves its own verbs on those two harnesses. Other harnesses may show their own MCP prompt once before the roster card, and a read-only persona there can't propose a Crew. Decided: Jackson, 2026-09-14 (artifacts) and 2026-09-26 (Codex and Claude only). Cost: a general fix belongs upstream (#276). FORK.md, saved-agent mentions section.
- **Agent deliveries queue; Astra peers can steer.** Upstream's thread-send steers or runs automatically. J5 queues agent-to-agent deliveries behind the active turn, except peer updates into a running Codex Astra turn, which arrive as steers. Decided: Jackson, 2026-09-03 (QS1), Astra exception 2026-09-04. Cost: changes when a message is admitted, not whether the model attends to it. FORK.md case 26.
- **Held A2A deliveries stay pending.** Upstream holds queued runs after a restart. J5 keeps its deliveries pending with a backoff recheck, never reporting them delivered. Decided: Jackson, 2026-09-24 (#6). Cost: senders aren't told their message is held (#272). FORK.md case 26.
- **A committed Stop wins.** Upstream can turn a steer accepted before Stop into a follow-up after it. J5 blocks that. Decided: Jackson, 2026-09-06. Cost: a temporary patch until upstream hardens interrupts. FORK.md, temporary patches.
- **Native resume follows the not-found rule.** Upstream V2 starts a fresh conversation, primed with a digest, on any resume failure. J5 starts fresh only when the provider says the conversation is gone, and says so visibly; any other failure is a visible error. Decided: Jackson, 2026-09-24 (#8). Cost: upstream appears to intend the fresh start; offered back via #276. FORK.md, temporary patches.

### Squadrons, threads, and lifecycle

- **The Squadron replaces the project as the unit of choice.** Upstream's user picks a project or folder everywhere. In J5, every new-thread door picks a Squadron, Add Project opens Create Squadron, a draft without a Squadron can't send, and upstream's project filters and "Open project" shortcuts are removed. Decided: Jackson, 2026-08-24 (SC2, SC3), 2026-08-29 (SB3), 2026-08-31 (E7), 2026-09-12, 2026-09-25. Cost: one folder per Squadron for now, and many small seams in upstream UI. FORK.md cases 9, 13, 15b, 16–20, 34.
- **Drafts name the Squadron.** Upstream's draft headline and placeholder name the project; J5's name the Squadron. Decided: Jackson, 2026-08-24 (SC3).
- **First run creates a Squadron.** Upstream's first run lands in a draft. J5 requires a named Squadron first, with no default. Decided: Jackson, 2026-08-24 (SC2). FORK.md case 9.
- **Unbound scheduled tasks can't create threads.** Upstream's unbound schedules create fresh threads; J5 refuses with a visible task failure, because a thread needs a Squadron. Decided: 2026-08-31 (DV5). Cost: scheduled creation waits on #273. FORK.md case 12.
- **Multi-model send carries the Squadron.** Upstream fans a draft out to several models. J5 carries the Squadron to each thread and refuses it from a persona draft, since a persona pins one model. Decided: Jackson, 2026-09-24 (#7b).
- **The sidebar is organized around Squadrons.** Upstream lists every thread, led by its folder. J5 hides agent-spawned Peer Agents unless pinned, leads cards with the Squadron, and adds seat and Captain chips and a spawned-children expander. Decided: Jackson, 2026-08-29 (SB5) and 2026-09-01 (#47). FORK.md case 23.
- **Archive warns with measured facts.** Upstream shows a generic confirmation. J5's web archive dialog lists what archiving will change, shows "Couldn't check" when a read fails, and refuses to archive a Crew seat alone. Decided: Jackson, 2026-08-29 (AR2, AR3), and the Crew unit rule (2026-08-21). Cost: mobile archive doors don't warn yet (#40). FORK.md cases 21, 22, 37.
- **A Crew follows its Captain.** Upstream's archive, unarchive, and settle each touch one thread. J5 moves a Captain's Crews with it through archive, delete, unarchive, settle, and unsettle. Settle keeps upstream's meaning and skips seats upstream wouldn't auto-settle. Decided: Jackson, 2026-09-26 (#312). FORK.md case 21.
- **Archive Undo is withheld when Crews may retire.** Upstream offers Undo after every archive. J5 hides it when the archive may retire a Captain's Crews, because unarchiving didn't bring them back. Decided: Jackson, 2026-09-24 (#7). This entry leaves the register once unarchive restores a Captain's Crews. FORK.md case 21.

### Timeline and composer

- **Agent-to-agent traffic renders as cards.** Upstream renders these rows generically. J5 renders deliveries and outbound sends as cards, keeps agent messages out of the minimap, and labels queued rows with their sender. Decided: Jackson, 2026-08-29 and 2026-08-31 (TA, TA6, TA7). FORK.md cases 7, 14, 24.
- **`@` offers saved personas first.** Upstream's `@` offers threads and files. J5 lists saved personas first, and a persona thread replaces the model controls with the persona's pinned route. Decided: Jackson, 2026-09-14.

### Storage, install, and identity

- **J5 never shares on-disk state with T3 Code.** Upstream uses `~/.t3`, `T3CODE_HOME`, and a `.t3` worktree directory. J5 uses `~/.j5code`, `J5CODE_HOME`, and `.j5code`, with no fallback to T3's, its own desktop profiles, and a migration bridge that refuses T3's databases. Decided: Jackson, 2026-08-30 (DQ5), 2026-09-02 (#68), 2026-09-24 (#1, #4). Cost: some Linux integrations still collide with an installed T3 Code (#138), and cosmetic `T3CODE_*` names remain. FORK.md cases 15, 25, 31.
- **J5 installs from its own release archives.** Upstream installs from npm. J5 installs the `j5` command from `Jacksondr5/j5code` release archives, on darwin-arm64 and linux-x64 only, and runs as `j5code.service`. Decided: Jackson, 2026-09-24 (#3, #3a). Cost: other platforms have no release. FORK.md cases 40, 41.

### Awaiting a decision

These already diverge on `j5/main`, but no human ruling is on record: each landed as an implementer's call inside a merged PR. Until the person rules, they are recorded here rather than treated as settled.

- **Squadron authorization on thread organize.** J5's organize tool requires Squadron authorization to archive another agent; upstream's needs only project access.
- **Merge-back limited to one Squadron.** J5 refuses merge-back unless both threads share a Squadron home or both are native.
- **A committed Stop also beats usage-limit auto-resume.** An extension of the committed-Stop patch, ported during the V2 advance without its own decision.
- **Codex CLI version floor.** J5 refuses Codex CLIs older than 0.151.0 with a named error; upstream has no minimum. FORK.md case 28.
- **Welcome wizard Squadron stage.** J5 adds a stage that gives imported conversations a Squadron home. FORK.md case 39.
- **Pair discovery isolation.** In a linked worktree with no running server, J5's `pair` refuses to fall back to the default home.
- **Behavioral branding identifiers.** App ID `codes.jackson.j5code`, URL scheme `j5code`, CLI `j5`, and J5 update URLs. Consistent with the on-disk separation ruling, but not ruled on directly.
- **`plan.md` export.** Plans are stored as app artifacts and exported to `plan.md` when finalized. FORK.md case 33.
- **Astra model aliases.** `astra`, `gpt-6`, and `6` resolve to `gpt-6-astra`. FORK.md case 32.

## History

- 2026-09-26 — created: the three zones, the decision protocol, and the register, seeded from FORK.md and the worklog records (Jackson, [#327](https://github.com/Jacksondr5/j5code/issues/327)).
