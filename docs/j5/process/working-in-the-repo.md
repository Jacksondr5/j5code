---
title: "Working in the repo — tool traps and facts every agent hits"
kind: spec
---

# Working in the repo

Durable, non-obvious facts about this repository and its tooling that agents rediscover the hard
way. Each entry earned its place by producing a wrong conclusion or a broken CI run at least once.
This doc holds **repo facts and tool traps only** — process law lives in the Spawner-owned standing
rules, and UI conventions in the Design-owned conventions doc. Nothing here goes into upstream-owned
files (`CLAUDE.md`, `README.md`): J5 guidance lives only under `docs/j5/`.

## `grep` silently returns nothing on large files — use `-a`

`grep` binary-detects the repo's largest source files and returns **zero matches without error**.
The canonical case is `apps/server/src/orchestration-v2/Orchestrator.ts` (~268 KB, ~7,300 lines):
a plain `grep` for a symbol that is definitely there prints nothing. A zero-match result on a file
that plausibly contains the term is indistinguishable from a true negative, so this produced a
confidently wrong "this mechanism does not exist" conclusion during the 2026-08-29 substrate
session.

**Do:** re-run with `grep -a` (or use the Grep tool) before concluding that something is absent
from a large file. Treat an empty result on a big file as suspect until `-a` confirms it.

## Format docs before committing, and keep lockfile churn out of docs PRs

CI runs `vp fmt --check`, and hand-written markdown almost always differs from the formatter's
output (it normalizes emphasis `*`→`_` and re-pads tables), so an unformatted docs commit fails CI.

**Do:** run `pnpm vp fmt` in the branch worktree before every docs commit. Then check the lockfile:
any `pnpm` invocation can annotate `pnpm-lock.yaml` with registry metadata (deprecation notes and
the like) — churn that does not belong in a docs-only PR. Restore it with
`git checkout origin/j5/main -- pnpm-lock.yaml` before committing.

One hook quirk: the pre-commit hook runs `vp fmt` over **staged** files, so a commit that stages
only a file the formatter ignores (a lockfile-only revert, for example) fails with "no target files."
For that case, and only that case, commit with `--no-verify`.

Also verify the shell's working directory before running these — across a long session the cwd can
silently reset to a different worktree between calls, and a formatter run lands in the wrong tree.

## `apps/web` component tests cannot exercise event handlers

`apps/web` component tests render with `renderToStaticMarkup` from `react-dom/server`, and the
package has no `@testing-library/react` and no jsdom/happy-dom. A test can assert **what renders**,
never **what happens** on `onChange`, `onClick`, or any other event. A whole defect class is
therefore invisible to CI and to code review that trusts "there are tests."

The motivating defect (PR #11, 2026-08-28): a handler read `event.currentTarget.value` _inside_ a
deferred `setState` updater. React nulls `currentTarget` once dispatch returns, so the first
keystroke threw and the feature's primary interaction was dead. Three review passes read the file
and missed it because the code looks like ordinary React; a component test in the house style
rendered the page happily and proved nothing. A visual pass found it.

**Do:** when reviewing web code, treat the existence of tests as no evidence about interaction
behavior — check whether anything actually exercises the handler, and say so in the verdict when
nothing does. For a user-visible surface, either get a real UI pass before signing off or state the
limitation explicitly. When a fix arrives with a rendering test attached, verify the test can fail
before crediting it. The discriminating unit-test form for deferred-updater bugs is to extract the
handler and invoke the returned updater _after_ nulling `currentTarget`. This is the empirical basis
for the fleet's UI-screenshot-before-merge rule — it is load-bearing, not ceremony.
