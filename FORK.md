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
- existing provider adapters and shared runtime modules
- vendored references under `.repos`

### Sanctioned appended integration cases

Against upstream pin `993407dd9e57f1edf2f5681d70140bfefeca93cc`, the complete A2A exception inventory is exactly these six cases. Line numbers identify this revision; the named symbol or test is the durable anchor after nearby upstream movement.

1. A1's independent Squadron communication-ledger migration lane: `apps/server/src/persistence/Layers/Sqlite.ts:10` imports `runJ5A2AMigrations`, and `:42` runs it after upstream migrations. Introduced by `a064a87ac40ea2d2d936ba72008c95edeb8bbc2b` and merged in `521c50aa9bb6b4c7f55bc10a772822ec31129f2d`.
2. The one shared authenticated J5 MCP registration seam: `apps/server/src/mcp/McpHttpServer.ts:31` imports `J5McpIntegrationLive`, and `:247-248` append its sole entry to `layer`. Registration stays in `apps/server/src/j5/a2a/mcp/registration.ts`; the combined HTTP/MCP runtime is provided once at case 5's server graph. A6 extends the J5-owned toolkit without another protected-file registration or runtime provider.
3. The internal delivery-dedup contract proof: `apps/server/src/orchestration-v2/runtimeLayer.test.ts:188-234`, test `replays an internal thread send without injecting a second message`.
4. The authenticated shared-toolkit integration proof: `apps/server/src/mcp/toolkits/worktree/registration.test.ts:15,70,83-90,128-131`, within test `production mcp layer lists worktree tools over http`.
5. A4's authenticated raw human-inbox route and shared-runtime composition: `apps/server/src/server.ts`, where `makeRoutesLayer` imports and appends `humanInboxHttpRouteLayer` after `websocketRpcRouteLayer`, imports `J5A2ARuntimeLayer`, and provides that runtime exactly once around the combined HTTP and MCP route graph. The J5-owned human-inbox route and MCP registration require that shared runtime and never provide nested copies. The route implementation remains in `apps/server/src/j5/a2a/HumanInboxHttp.ts`; `apps/server/src/http.ts` and shared wire contracts remain untouched.
6. A4's visible human-inbox navigation append: `apps/web/src/components/sidebar/SidebarChrome.tsx`, where `SidebarChromeFooter` recognizes `/inbox` and appends its footer navigation button. The route and page remain under J5-owned files.

`apps/web/src/routeTree.gen.ts` is generated output, not a hand-authored exception. When a J5-owned route file changes, regenerate it with the normal web build and review only the generated route registration delta; never edit the generated tree directly.

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

| Date       | Pin                                        | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-08-15 | `77168d081abbdd7522f90b3b204cc693015d5f26` | Original setup-plan pin. The upstream branch was later force-rewritten; this commit is not an ancestor of the rewritten live tip. No J5 build or baseline was created from it.                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2026-08-15 | `993407dd9e57f1edf2f5681d70140bfefeca93cc` | First deliberate reviewed advance, before J5 changes. Review of `038560e58036d51b2576b3c2cd9170a194cefe9e..993407dd9` found 336 commits: the branch is rebased onto upstream `main` at `ad117235b`, with 233 orchestration-branch commits on top. The log retains the V2 runtime, contracts, provider adapters, client cutover, migration renumbering, and follow-up fixes/tests; no commit advertised reverting or retiring V2. Reconciliation commits call out repaired rebase conflicts and restored main features, so T2 must establish a fresh full-suite baseline at this exact pin. |

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
