---
title: "Pull requests — the checklist, and how to show a UI change"
kind: process
---

# Pull requests

Every PR uses the [PR template](../../../.github/pull_request_template.md). This page explains the checklist items that agents most often get wrong, and how to produce UI evidence that a reviewer can actually use.

## The checklist, explained

- **One concern.** If the description needs the word "also", it's two PRs. Stacked PRs are fine when each one is a single concern and its description states the merge order.
- **Tests cover the changed behavior.** A test that only mirrors the implementation, or renders a component to static markup, isn't coverage. Say plainly what isn't tested.
- **Screenshots for UI changes.** See [Screenshots](#screenshots) below. There are no exceptions for "small" UI changes; small visual changes are the easiest to get subtly wrong.
- **Upstream-owned files are recorded in FORK.md in the same PR.** Every edit to a file outside the J5-owned paths gets its case text and file-table row in [`FORK.md`](../../../FORK.md), in the PR that makes the edit. Review panels regularly find missing rows and stale case text; a follow-up PR to fix FORK.md is too late, because the next PR in a stack builds on the wrong record.
- **Changes to upstream's product need a human decision.** If the PR changes what upstream's product does (see the zones in [J5 and upstream](../product/upstream.md)), link the decision and add or update the register entry. A FORK.md case records the code; it doesn't stand in for the decision.
- **Surfaces.** Walk the list in `AGENTS.md` and say in the PR which entries applied and which didn't.

## Screenshots

A reviewer should be able to judge a UI change from the PR page alone, without running anything.

**What to capture**

- **Before and after, for every UI change**: before from the base branch, after from the PR's head. Use the same data, the same viewport, and the same theme in both, so the difference is the change.
- Capture every state the PR touches: empty, loading, error, the populated case, and any state the change adds (for example "Unknown" or "Not created"). If a state is hard to reach, say so rather than skip it silently.
- Crop to the area that changed, with enough surroundings to locate it.
- Motion, timing, or an interaction sequence needs a short video (MP4 or GIF).
- Mobile changes need simulator or emulator captures (see the `test-t3-mobile` skill).

**How to capture**

- Use an isolated dev server in your own worktree, seeded with a copy of real data (see "Test data" in `AGENTS.md`). Never capture from, or point a browser at, the developer's live install.
- Capturing the screenshots for a PR you were asked to open is part of that request; you don't need separate permission to start a browser for it.
- Check each file is what it claims to be before uploading: `file shot.png` should say "PNG image data". Tools sometimes write JPEG or WebP bytes under a `.png` name, which GitHub won't render.

**Where to put them**

- Push the images to the `j5/evidence` branch under `pr-<number>/`, using a separate worktree or clone checked out on that branch. Other agents push there too: fetch and rebase before you push.
- Embed them with raw links, which render inline: `https://raw.githubusercontent.com/Jacksondr5/j5code/j5/evidence/pr-<number>/<file>.png`. A `github.com/.../blob/...` link shows a file page, not an image.
- Before posting, check each link returns the image: `curl -sI <url>` should show `200` and an `image/` content type.
- Never commit screenshots to the PR's own branch, or to paths like `.github/pr-assets/`.

**How to present them**

- Put them in the PR description's **UI changes** section, as before/after pairs with a one-line caption saying which state each shows.
- When a later push changes the UI, replace the images in the description (upload new files, with new names). Don't post a new "evidence" comment on every push; reviewers should find the current state in one place.
- Keep captions to what the image shows. Commit SHAs, temp paths, fixture receipts, and capture logs don't help the reviewer and bury the images.
- If you couldn't capture something (no browser, a state you couldn't reach), say so in the description. Never imply a UI was verified when it wasn't.
