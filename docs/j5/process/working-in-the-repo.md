---
title: "Working in the repo — tool traps, repo facts, and contributor rules"
kind: spec
---

# Working in the repo

Durable, non-obvious facts about this repository and its tooling, plus the rules that govern the
code itself. Each entry earned its place by producing a wrong conclusion, a broken CI run, or a
rebase tax at least once. The test for what belongs here: **is it a fact about the codebase?**
How the fleet or its operator works — gates, evidence, staffing, personal preferences — is
deliberately not here; that lives in the operator's playbooks outside the repo. Nothing here goes
into upstream-owned files (`CLAUDE.md`, `README.md`): J5 guidance lives only under `docs/j5/`.

## Contributor rules — what governs the code

One line each, with the why.

- **No dead code ships without a reachable or named imminent consumer** (2026-08-31). Existence is
  not reachability: a hook with zero call sites is a maintenance trap, not a feature, and two
  authorized change maps once targeted exactly such a hook. Name the consumer or don't ship it.
- **Pre-dogfood, no legacy-compatibility code, ever** (Jackson, 2026-09-01). Accommodations for
  data or states that cannot exist yet (no users, no legacy drafts) are YAGNI and get deleted;
  invariants stay and fail closed, loudly.
- **J5 content lives only under `docs/j5/` and the `j5/` code paths; upstream-owned files are edited
  only as the integration cases enumerated in [`FORK.md`](../../../FORK.md)** ("Add, don't modify").
  Every edit to an upstream-owned file is a permanent rebase-conflict tax against upstream; the
  fork's discipline is add-beside, and the sanctioned exceptions are listed there, not improvised.
- **UI copy capitalization follows upstream's measured convention** (Jackson, 2026-09-01).
  Capitalization and copy style for labels, menus, and options are determined by measuring
  comparable upstream surfaces, never assumed — a codebase-consistency fact, not taste.

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
handler and invoke the returned updater _after_ nulling `currentTarget`.
