---
title: "Pull requests — the checklist explained"
kind: process
---

# Pull requests

Every PR uses the [PR template](../../../.github/pull_request_template.md). This page explains the checklist items that agents most often get wrong.

## The checklist, explained

- **One concern.** If the description needs the word "also", it's two PRs. Stacked PRs are fine when each one is a single concern and its description states the merge order. A stack is split only to make it easier to review, and it merges together, so judge its behavior as the code that lands: don't flag a behavior issue in one PR that a later PR in the same stack fixes. Requirements on each PR still apply to that PR, including recording its own upstream edits in FORK.md.
- **Tests cover the changed behavior.** A test that only mirrors the implementation, or renders a component to static markup, isn't coverage. Say plainly what isn't tested.
- **Screenshots for UI changes.** Before and after, for every UI change, with a short video for motion or interaction. There are no exceptions for "small" UI changes; small visual changes are the easiest to get subtly wrong.
- **Upstream-owned files are recorded in FORK.md in the same PR.** Every edit to a file outside the J5-owned paths gets its case text and file-table row in [`FORK.md`](../../../FORK.md), in the PR that makes the edit. Review panels regularly find missing rows and stale case text; a follow-up PR to fix FORK.md is too late, because the next PR in a stack builds on the wrong record.
- **Changes to upstream's product need a human decision.** If the PR changes what upstream's product does (see the zones in [J5 and upstream](../product/upstream.md)), link the decision and add or update the register entry. A FORK.md case records the code; it doesn't stand in for the decision.
- **Surfaces.** Walk the list in `AGENTS.md` and say in the PR which entries applied and which didn't.

## Stacks

A chain of PRs, each based on the branch of the one below, is not a stack until GitHub is told it is one. Link the chain when you open it, and merge it in one operation. Both use the `gh stack` extension (`gh extension install github/gh-stack`).

- **Link it.** After opening the PRs, run `gh stack link --base j5/main <bottom PR> ... <top PR>`, bottom to top. To add a PR to a stack later, run it again with the stack's PRs and the new one on the end.
- **Keep it one line.** A stack has no branches: each PR has exactly one PR above it. Two PRs based on the same layer can't both join, so put the second on top of the first, or leave it out and merge it on its own afterwards.
- **Merge it from the top.** When every layer is green and approved, run `gh stack merge <top PR> --yes --squash`. GitHub merges that PR and every open one below it, all or none. Don't merge the layers one at a time: each merge makes GitHub rebase the rest, and every layer then waits for a new CI run.
- **`gh pr merge` refuses a stacked PR,** as does the ordinary merge API. That refusal means "use the stack merge", not "merge this one alone".
- **Merging part of a stack** is for when the upper layers aren't ready: pass the highest PR that is.
