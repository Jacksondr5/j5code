## Problem

<!-- One or two sentences: what was wrong or missing, and for whom. Link the tracking issue on this repository: "Closes #123". -->

## What changed

<!-- How you fixed it, and why this shape. Keep scope tight: one concern per PR. -->

## UI changes

<!-- Required for any UI change: before and after screenshots, same data and viewport.
     Motion or timing needs a short video. Host them on the j5/evidence branch and embed
     raw.githubusercontent.com links. See docs/j5/process/pull-requests.md#screenshots.
     Delete this section only if nothing visible changed. -->

## Upstream impact

<!-- Delete if the PR only touches J5-owned paths (apps/*/src/j5, packages/*/src/j5, docs/j5).
     Otherwise list each upstream-owned file you edited and its FORK.md case.
     If the PR changes what upstream's product does, link the human decision
     and the register entry in docs/j5/product/upstream.md. -->

## Checklist

- [ ] One concern: the description has no "also"
- [ ] Tests cover the changed behavior (backend changes ship with focused tests)
- [ ] UI changes: before/after screenshots embedded above, and a video for motion or timing
- [ ] Upstream-owned files: each one is recorded in `FORK.md` (case text and file-table row) in this PR
- [ ] Upstream product: any change to what upstream's product does has a human decision linked above and a register entry in `docs/j5/product/upstream.md`
- [ ] Surfaces: entry points, clients, providers, contracts, reverse states, connection modes (see `AGENTS.md`)
- [ ] Docs: definitions under `docs/j5/product/` and user docs rewritten where this changes them

<!-- End with the model and harness that did the work. -->
