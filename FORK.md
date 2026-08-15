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

If a required change cannot fit this discipline, stop and review the exception before implementing it.

## Pin and upstream advance runbook

Current pin: `993407dd9e57f1edf2f5681d70140bfefeca93cc` (2026-08-15), selected from upstream PR [#2829](https://github.com/pingdotgg/t3code/pull/2829), `t3code/codex-turn-mapping`.

The upstream PR branch is moving history and has already been force-rewritten. Do not assume a future branch tip descends from this commit.

### Pin log

| Date | Pin | Decision |
| --- | --- | --- |
| 2026-08-15 | `77168d081abbdd7522f90b3b204cc693015d5f26` | Original setup-plan pin. The upstream branch was later force-rewritten; this commit is not an ancestor of the rewritten live tip. No J5 build or baseline was created from it. |
| 2026-08-15 | `993407dd9e57f1edf2f5681d70140bfefeca93cc` | First deliberate reviewed advance, before J5 changes. Review of `038560e58036d51b2576b3c2cd9170a194cefe9e..993407dd9` found 336 commits: the branch is rebased onto upstream `main` at `ad117235b`, with 233 orchestration-branch commits on top. The log retains the V2 runtime, contracts, provider adapters, client cutover, migration renumbering, and follow-up fixes/tests; no commit advertised reverting or retiring V2. Reconciliation commits call out repaired rebase conflicts and restored main features, so T2 must establish a fresh full-suite baseline at this exact pin. |

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
