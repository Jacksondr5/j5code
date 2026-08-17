---
title: "T1 — Repo setup: fork, pin, FORK.md"
kind: ticket
status: 2
---

# T1 — Repo setup

**Goal:** `github.com/Jacksondr5/j5code` exists as a **public, proper GitHub fork** of `pingdotgg/t3code` (Jackson's call 2026-08-15: public so the fork relationship gives visible attribution), holding T3 Code pinned at the agreed orchestration-v2 tip, with the fork discipline written down. No code changes.

## Scope

- Fork via GitHub's fork mechanism: `gh repo fork pingdotgg/t3code --fork-name j5code` (public, network-attached to upstream for attribution).
- Clone the fork; fetch upstream branches; create our default branch `j5/main` at **`993407dd9`** (first deliberate reviewed advance from the original `77168d081` pin on 2026-08-15); push `j5/main` (plus ensure `main` and `t3code/codex-turn-mapping` refs exist on the fork); set `j5/main` as the repo default branch via `gh`.
- Remotes documented: `origin` = j5code, `upstream` = pingdotgg/t3code.
- Write `FORK.md` at repo root: (1) add-don't-modify rules — our code goes in new files/packages; appended switch cases are the only sanctioned edits to upstream files; list of off-limits areas (upstream's server core, contracts, client-runtime except appends); (2) rebase runbook — while PR #2829 is open: advance the pin deliberately (weekly, reviewed diff of upstream reconciles); after it merges: monthly rebase onto upstream release tags; squash-merge recovery = cherry-pick our new-file commits onto the new base; (3) the pin record: current pinned SHA + date, updated on every advance.
- Record the pin + repo URL back in `fork-setup-plan/index.md`.

## Out of scope

Renaming (T3), building (T2), CI (T5).

## Dependencies

None. **Blocks T2.**

## Acceptance

`github.com/Jacksondr5/j5code` is public and shows "forked from pingdotgg/t3code"; default branch `j5/main` shows T3 Code source at `993407dd9`; `FORK.md` present; `git remote -v` instructions in FORK.md reproduce the two-remote setup.

## Result — 2026-08-15

- Created [`Jacksondr5/j5code`](https://github.com/Jacksondr5/j5code) through GitHub's fork mechanism. Verified via GitHub API: `fork: true`, `parent: pingdotgg/t3code`, `visibility: public`.
- Cloned to `/Users/jackson/repos/jacksondr5/j5code`. Verified `origin` is the J5 fork and `upstream` is `pingdotgg/t3code`.
- Set the default branch to `j5/main`. It contains the reviewed upstream pin `993407dd9e57f1edf2f5681d70140bfefeca93cc` plus J5's first new-file-only commit, `09d4b61c9` (`FORK.md`). Verified the pin is an ancestor of the default-branch head.
- Verified fork refs: `main = ad117235b`, `t3code/codex-turn-mapping = 993407dd9`, and `j5/main = 09d4b61c9`.
- Added `FORK.md` with reproducible two-remote clone instructions, add-don't-modify boundaries, an upstream-advance runbook, squash/rewrite recovery, and the auditable two-entry pin log.
- Surprise: PR #2829 changed from draft to open/non-draft and its branch was force-rewritten after the original plan pin. The reviewed range `038560e58..993407dd9` contains 336 commits, including 233 orchestration-branch commits atop current `main` (`ad117235b`). Commit-level review found the V2 runtime/contracts/adapters/client cutover intact, follow-up reconciliation and migration-renumbering fixes, and no advertised V2 rollback. T2 therefore establishes the fresh baseline only at the new pin.
