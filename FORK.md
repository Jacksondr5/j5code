# J5 Code fork discipline

J5 Code is a public fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). The visible GitHub fork relationship preserves upstream attribution. This file records how we keep local work easy to audit and carry across upstream history changes.

## Remotes

Every working clone uses these remotes:

```text
origin   https://github.com/Jacksondr5/j5code.git
upstream https://github.com/pingdotgg/t3code.git
```

Reproduce that setup with:

```sh
git clone https://github.com/Jacksondr5/j5code.git
cd j5code
git remote add upstream https://github.com/pingdotgg/t3code.git
git fetch --all --prune
git switch j5/main
# j5/main is the canonical fork branch; do not use fork-local main; upstream refs live under the upstream remote.
```

## Add, don't modify

J5-specific code belongs in new files or new packages. Keep commits narrow and organized so they can be cherry-picked onto a new upstream base.

The only sanctioned edits to upstream-owned files are small appended integration cases, such as a new switch case or registry entry that makes a new J5-owned module reachable. Do not refactor surrounding upstream code while adding a case.

Treat these upstream areas as off-limits except for those explicit appended cases:

- `apps/server` core orchestration and persistence
- `packages/contracts`
- `packages/client-runtime`
- `apps/web` existing application components and render paths
- existing provider adapters and shared runtime modules
- vendored references under `.repos`

### Sanctioned appended integration cases

Against upstream pin `993407dd9e57f1edf2f5681d70140bfefeca93cc`, the complete A2A exception inventory is exactly these twelve cases. Line numbers identify this revision; the named symbol or test is the durable anchor after nearby upstream movement.

1. A1's independent Squadron communication-ledger migration lane: `apps/server/src/persistence/Layers/Sqlite.ts:10` imports `runJ5A2AMigrations`, and `:42` runs it after upstream migrations. Introduced by `a064a87ac40ea2d2d936ba72008c95edeb8bbc2b` and merged in `521c50aa9bb6b4c7f55bc10a772822ec31129f2d`.
2. The authenticated J5 MCP registration seam: `apps/server/src/mcp/McpHttpServer.ts:31-34` imports `J5McpIntegrationLive` and `J5OrchestratorSurfaceRegistrationLive`; `:246-252` selects the J5-owned orchestration allowlist and appends the J5 communication toolkit. The complete upstream `OrchestratorToolkitRegistrationLive` remains compiled at `:229-232` but is intentionally absent from the production merge. Registration stays in `apps/server/src/j5/a2a/mcp/registration.ts`; the combined HTTP/MCP runtime is provided once at case 5's server graph. `t3_thread_read` and `t3_thread_wait` are intentionally re-declared in J5-owned code with factual thread-state prose because the upstream Tool descriptions contain excluded app-owned/delegation semantics; never replace them with the upstream Tool constants during a rebase. `list_participants` exposes every result field in snake_case at every depth, including nested agent `thread_id`, provenance `spawned_by_participant_id` / `source_participant_id`, `placement_parent_id`, and `display_name`; never restore any upstream camelCase directory or provenance field during a rebase. Later J5 verbs extend the fork-owned toolkit without another protected-file registration or runtime provider.
3. The internal delivery-dedup contract proof: `apps/server/src/orchestration-v2/runtimeLayer.test.ts:188-234`, test `replays an internal thread send without injecting a second message`.
4. The authenticated shared-toolkit integration proof: `apps/server/src/mcp/toolkits/worktree/registration.test.ts:15,70,83-90,122-146`, within test `production mcp layer lists worktree tools over http`; it asserts the retained J5 orchestration surface and the absence of excluded delegation, raw thread-send/interrupt, and thread-creation tools. The upstream provider-adapter read-only-tool assertion derives its expectation from the upstream toolkit rather than the J5 production surface, so it is intentionally unchanged; this direct J5 exact-registration proof is the gate of record. Revisit that protected upstream read-only assertion only after an actual drift incident that this J5 proof fails to catch.
5. A4's authenticated raw human-inbox route and shared-runtime composition: `apps/server/src/server.ts`, where `makeRoutesLayer` imports and appends `humanInboxHttpRouteLayer` after `websocketRpcRouteLayer`, imports `J5A2ARuntimeLayer`, and provides that runtime exactly once around the combined HTTP and MCP route graph. Its single `server.ts` entry is now the general J5 aggregate recorded at case 9. The J5-owned human-inbox route and MCP registration require that shared runtime and never provide nested copies. The route implementation remains in `apps/server/src/j5/a2a/HumanInboxHttp.ts`; `apps/server/src/http.ts` and shared wire contracts remain untouched.
6. A4's visible human-inbox navigation append: `apps/web/src/components/sidebar/SidebarChrome.tsx`, where `SidebarChromeFooter` recognizes `/inbox` and appends its footer navigation button. The route and page remain under J5-owned files.
7. B3's thread A2A rendering seam: `apps/web/src/components/chat/MessagesTimeline.tsx:47` imports J5-owned `renderThreadA2ADelivery`; `TimelineRowContent` at `:1038-1046,:1073-1076` calls it only for `row.kind === "message" && row.message.role === "user"`, passes the complete `ChatMessage` plus one `formatDayAwareTimestamp` label from `TimelineRowCtx`, and renders the generic `UserTimelineRow` only when `a2aDelivery === null`. Classification, envelope parsing, raw fallback, and focused proof remain in `apps/web/src/j5/a2a/ThreadA2ARenderer.tsx` and `.test.tsx`; TA4 stays absent.
8. A2's provider steering seam: `apps/server/src/provider/T3OrchestrationInstructions.ts:7-12` replaces upstream delegated-task steering with current-head truth: provider-native Subagents remain provider-owned, this MCP surface cannot create Peer Agents yet, and Exchanges can be opened only with already listed participants. The schedule paragraph stays unchanged. `apps/server/src/provider/T3OrchestrationInstructions.test.ts:9-29`, test `steers only to current provider-native Subagents and addressable Peer Agents`, is the narrow terminology/phantom-tool proof. The composed-prompt assertions in `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts` and `ClaudeAdapterV2.test.ts` import and assert `T3_CODE_ORCHESTRATION_INSTRUCTIONS` rather than pinning product wording; future authorized wording changes therefore require neither adapter-test edits nor another seam request. A rebase restoring an upstream literal is a protected-seam regression, not an authorized wording update. This A2 lane owns moving the ratified SP4 brief sentence into the actual J5 `spawn_agent` Tool description when that post-#18 verb lands; global steering must not name the unavailable Tool or carry its brief coaching in the interim.

`apps/web/src/routeTree.gen.ts` is generated output, not a hand-authored exception. When a J5-owned route file changes, regenerate it with the normal web build and review only the generated route registration delta; never edit the generated tree directly.

9. SQ1's first-run gate, visible Squadron controls, and authenticated J5 route aggregate: `apps/web/src/routes/_chat.index.tsx:12-48` imports J5-owned gate/directory logic and wraps only the non-hosted-static `IndexDraftLanding` return; the hosted-static onboarding branch at `:30-32` remains unchanged. The gate's state is a real authenticated `GET /api/j5/squadrons` read, not a hard-coded unavailable state. `apps/web/src/components/Sidebar.tsx:140-150,1889-1904,3402,3580-3587` is the sole sidebar-zone `<SquadronScopeDropdown />` mount and J5-owned scope consumer; it does not alter chrome, footer, inbox, or roster. `apps/web/src/j5/squadron/SquadronCreateForm.tsx` is shared by the first-run gate and the J5-only ScopeDropdown `Create Squadron…` action: both require explicit name plus one selected primary-environment folder, POST the existing route, refresh the directory, then select only the created Squadron. `apps/web/src/j5/squadron/SquadronDraftState.ts:9-18,43-50,76-83` retains scalar ambient scope semantics and increments a separate selection generation on every explicit choice, including Alpha→Alpha. `apps/web/src/j5/squadron/ThreadHomesClient.ts:109-121,132-145` reads B6's opaque batch `threadId → Registrar-home` response unchanged; Sidebar alone supplies that generation to reread its current raw thread ids for a named scope (zoom-out never forces), replacing stale `unknown` or failed/missing entries with durable Registrar homes. Its pure predicate admits only known homes matching a selected Squadron, excludes unknown/native rows, and the explicit `No ambient Squadron` state remains zoomed-out/all rows; it never proxies through `projectId`. `apps/web/src/components/ChatView.tsx:249-258,1549-1551,1809-1823,5213-5234,5445-5450,6572-6581` reads the active server thread through that opaque response; a known durable home takes precedence for a visible disabled chip, while unknown/native/legacy threads have none. Its J5-owned chip retains the pre-send explicit mutable draft behavior, freezes it before the initial RPC, and passes only the explicit selected id. `apps/web/src/components/chat/DraftHeroHeadline.tsx:1-10` is display-only. State, pure predicates, and UI stay in `apps/web/src/j5/squadron/`; no first choice is inferred. In `apps/server/src/server.ts:78-79,337-342,427-449`, `j5AuthenticatedRoutesLayer` is the one replacement for A4's raw route entry after `websocketRpcRouteLayer`, and the core J5 creation layer is provided once to the V2 runtime. The J5-owned aggregate in `apps/server/src/j5/a2a/J5AuthenticatedRoutes.ts:7-15` composes A4's human inbox with SQ1's Squadron list/create routes and B6's thread-home read. Future J5 authenticated route layers enter through this aggregate, never through another `server.ts` entry. On every rebase, verify these web mounts still have these boundaries, no project proxy, and the single server entry still follows `websocketRpcRouteLayer`.
10. SQ1's lossless launch carrier and durable attach boundary: `packages/contracts/src/orchestrationV2.ts:2322-2342` adds additive-optional unbranded `squadronId` at `:2325`; `packages/client-runtime/src/operations/commands.ts:143-158,574-595` carries it only from an explicit first-message caller into the launch RPC; `apps/server/src/ws.ts:1231-1236` forwards it only when present before the fixed `creationSource`; and `apps/server/src/orchestration-v2/ThreadLaunchService.ts:63-79,545-611` sends the carrier to J5's shared creation engine only after the thread is durable and before preparation is scheduled. The shared engine is provided once in `apps/server/src/server.ts:337-342`; the boundary rejects absence or invalid references without defaults, preserves the named durable orphan on failure, and retry uses the same deterministic registration command. On every rebase, verify this exact client → contract → WebSocket → launch → J5-engine chain, one runtime provider, and no parallel HTTP launch door.
11. SQ1's plan-provenance launch carrier is its own protected contract exception: `packages/contracts/src/orchestrationV2.ts:2322-2327` adds additive-optional `sourcePlanRef`; it is not an existing generic field and has no default. `packages/client-runtime/src/operations/commands.ts:143-158,574-580,610-613,663-667`, `apps/server/src/ws.ts:1231-1236`, and `apps/server/src/orchestration-v2/ThreadLaunchService.ts:63-79,548-592` pass it only from the plan→implementation launch. After durable child identity, ThreadLaunch reads the parent Registrar home through the shared engine: a known home is inherited; a legacy no-home parent remains the named native cohort, with neither refusal nor default. On every rebase, verify this additive contract field and the durable-before-preparation order.
12. SQ1's DV5 scheduled-new-thread refusal: `apps/server/src/scheduledTasks/ScheduledTaskService.ts:31-33,161-167,475-502` uses J5's named policy to refuse an unbound scheduled creation before `ThreadLaunch`, persisting a visible task failure rather than inventing scheduler provenance or a Squadron. `apps/server/src/scheduledTasks/ScheduledTaskService.test.ts` proves both actual stored `user/web` and `agent/mcp` schedules become visible failures. On every rebase, verify the scheduled path remains an explicit unsupported/refused return pending scheduling-context work.

13. SQ1's opt-in primary-first Squadron folder-selection seam: `apps/web/src/commandPaletteBus.ts:7-31` adds the optional `onProjectSelected` carrier and its explicit durable project/folder payload; `apps/web/src/components/CommandPalette.tsx:393-518,1692-1809` retains that carrier only for an opt-in `add-project` open, returns an existing or newly created project before its normal navigation branch, and clears it on close. When absent, every existing Add Project caller retains its normal navigation behavior. `apps/web/src/j5/squadron/SquadronCreateForm.tsx:16-101` is the only SQ1 caller: it presents name before folder, uses the ordinary picker, displays the returned human title and path rather than a UUID, and creates the Squadron before first-run landing opens a thread. On every rebase, verify both protected upstream anchors retain the absent-carrier default and that J5 still has no inferred folder or Squadron home.

DV5 extends cases 9–12 without opening a second creation door. `apps/web/src/j5/squadron/FirstRunGate.tsx` creates a named Squadron only from the one explicitly selected primary-environment folder, and state-names a non-primary refusal; `Sidebar.tsx` replaces the old project scope zone with a Squadron scope whose pure predicate filters the real thread list only by immutable Registrar home: selected scope excludes unknown/native, while the explicit unscoped state shows all rows. `DraftHeroHeadline.tsx` renders only `What should we build in ⟨Squadron⟩?`. The plan→implementation behavior is recorded separately in case 11, including its additive `sourcePlanRef` contract exception. On every rebase, verify the inherited-home lookup remains after durable child identity and before preparation, the Sidebar home read has no project proxy, and the separately named mobile, scheduled, system-bootstrap, and agent-spawn returns remain explicit in `SquadronLaunchPolicy.ts` and `docs/j5/product/dogfood-v0.md` DV5.

These are per-instance Director/Jackson-authorized exceptions, not standing category permission. The earlier fork rebrand is separately complete at `0c0de1acefea00a34f9529bb97be32ff5056cfcc`; its rebase-critical boundary is recorded in `BRANDING.md:1-5,24-35`. The supporting fork setup plan (`artifacts/fork-setup-plan/index.md:8-12`) and its six T1-T6 ticket artifacts are internal project records and are not present in this repository.

If a required change cannot fit this discipline, stop and review the exception before implementing it.

### Fork-owned migration lane

J5 schema migrations use a J5-owned migrator, tracking table, and migration-id space. Never register
a J5 migration in upstream's `apps/server/src/persistence/Migrations.ts`: after an upstream advance,
a previously recorded J5 id could cause a new upstream migration with the same or lower id to be
silently skipped. Keep the lanes independent and retain only the small startup call that runs J5
migrations after upstream migrations.

## Pin and upstream advance runbook

Current pin: `993407dd9e57f1edf2f5681d70140bfefeca93cc` (2026-08-15), selected from upstream PR [#2829](https://github.com/pingdotgg/t3code/pull/2829), `t3code/codex-turn-mapping`.

The upstream PR branch is moving history and has already been force-rewritten. Do not assume a future branch tip descends from this commit.

### Pin log

| Date       | Pin                                        | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-15 | `77168d081abbdd7522f90b3b204cc693015d5f26` | Original setup-plan pin. The upstream branch was later force-rewritten; this commit is not an ancestor of the rewritten live tip. No J5 build or baseline was created from it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2026-08-15 | `993407dd9e57f1edf2f5681d70140bfefeca93cc` | First deliberate reviewed advance, before J5 changes. Review of `038560e58036d51b2576b3c2cd9170a194cefe9e..993407dd9` found 336 commits: the branch is rebased onto upstream `main` at `ad117235b`, with 233 orchestration-branch commits on top. The log retains the V2 runtime, contracts, provider adapters, client cutover, migration renumbering, and follow-up fixes/tests; no commit advertised reverting or retiring V2. Reconciliation commits call out repaired rebase conflicts and restored main features, so T2 must establish a fresh full-suite baseline at this exact pin.                                                                                                                                                                                                                                                                                                         |
| 2026-08-29 | (kept `993407dd9`)                         | Reviewed drift vs live tip `d6ed793b1e445aa81c1c91ff580a1def11db7d0a` (force-rebased again; pin not an ancestor; content diff 988 files). Every inventory anchor byte-identical or trivially additive (runtimeLayer.test.ts +1 distant test block); composed-with V2 surfaces (SubagentProjection, KeyedSerialExecutor, EffectOutbox, orchestrator/worktree toolkits, ThreadLaunchService) byte-identical. Behavioral deltas nearby but non-breaking: McpSessionRegistry capability gating (#7083); 3 new upstream migrations with V2 renumbering 041-049→044-052 (J5's independent migration lane unaffected). Decision: KEEP pin — nothing needed, tip already CONFLICTING with main again, advance would preempt lanes for no A7 cost reduction. #2829 merge proximity judged UNCLEAR: no approval, DIRTY merge state, no maintainer merge-intent statement, round-16 reconciliation treadmill. |

### Toolchain migration at the first advance

The original setup plan expected Bun. The advanced pin instead declares pnpm `11.10.0`, a `pnpm-lock.yaml`, Node `^24.13.1`, and 15 pnpm `patchedDependencies`. Vite Plus is a pinned repo-local dev dependency; the pnpm prepare step runs its workspace configuration without a separate account or global install.

Builds and CI follow the declarations at the recorded pin: use fnm with the version in `.nvmrc` and run `pnpm install --frozen-lockfile`. Do not create a Bun lockfile or change the machine-wide Node installation to compensate for an old pin's instructions.

The advanced lockfile also selects `sysinfo` `0.39.3`, whose declared minimum is Rust `1.95`.
J5 pins Rust `1.95.0` in `rust-toolchain.toml`; rustup applies that version only inside this
repository, while Jackson's machine default remains independent. The desktop artifact builder
already uses Cargo's committed lock with `--locked`.

Until PR #2829 merges:

1. Keep `j5/main` at the recorded pin between deliberate advances.
2. At most weekly, fetch `upstream` and review the full old-pin-to-candidate diff, including any force-rewrite divergence.
3. Advance only after that diff and the J5 test baseline are reviewed.
4. Update the SHA and date in this file in the same commit as every advance.

After PR #2829 merges:

1. Rebase monthly onto an upstream release tag, not an unrecorded branch tip.
2. Review upstream release notes and the complete old-base-to-new-tag diff.
3. Re-run the J5 build, test baseline, and packaging checks before updating `j5/main`.
4. Update the SHA and date in this file in the same commit as every advance.

If upstream squash-merges or rewrites the work so a normal rebase is misleading, create a branch from the selected new upstream base and cherry-pick J5's new-file commits. Reapply only the minimal appended integration cases, then review the resulting exact delta.

## J5 CI and packaging

Fork-owned workflows use the Node version in `.nvmrc`, pnpm `11.10.0`, the frozen pnpm lockfile, and
the repo-local Vite Plus binary. `J5 CI` is the push/PR gate for `j5/**`; `J5 Weekly Full Build` is the
scheduled and manually dispatchable pre-rebase suite plus Apple Silicon desktop build.

See [`docs/j5/macos-packaging.md`](docs/j5/macos-packaging.md) for the local build, signature
verification, install, Gatekeeper approval, and workflow runbook.
