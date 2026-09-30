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
