# J5 design docs — mirrored from the design workspace

This tree mirrors the durable product, research, and planning documents for the
J5 fleet-management effort. They were authored in the team's agent design
workspace (Traycer epic artifacts) and are mirrored here so anyone working in
this repo — human or agent — can read the reasoning behind the build without
access to that workspace.

**The mirror is a snapshot, not the working medium.** Design sessions continue
in the workspace; settled changes land here through docs PRs. Each document
describes the codebase and decisions _as of when it was written_ — check dates
before treating details as current. Documents carry YAML frontmatter from the
source system (`kind`: spec = durable context, ticket/story = work items with
`status` 0/1/2 = todo/in-progress/done); it is preserved for fidelity.

## Reading order for newcomers

1. `product/fleet-vision/` — why this exists: the operating model and thesis.
2. `research/synthesis/` — what we learned from T3 Code and Traycer, and the
   engineering principles adopted from each.
3. `research/jackson-prior-art/fleet-interviews-synthesis/` — field lessons
   from a real production agent fleet, and the platform/non-platform boundary
   that governs scope decisions.
4. `product/decision-log/` — every settled product decision, one row each.
5. `product/a2a/` — the A2A (agent-to-agent communication) design: decision
   register, grounding model, and `plan/` with the milestone plan and tickets.
6. `product/dashboard/pr-pane/` — the PR pane brief (first human-engineer
   workstream).

## Contents

- `backlog/` — the prioritized roadmap.
- `product/` — product designs and decisions (A2A, communication graph,
  dashboard, decision log, fleet vision).
- `research/` — the studies behind the decisions: T3 Code deep dives (the
  upstream this repo forks), Traycer's A2A/organization model, and the
  prior-art fleet studies. A quarantined, superseded early T3 snapshot was
  deliberately not mirrored.
- `fork-setup-plan/` — how this fork was established (base pin, rebrand,
  CI, load-test baseline).
- `process/` — working-process notes for the agent teams building here.

Cross-references between documents use relative paths and survive within this
tree. References to `interviews/` point at the public
`Jacksondr5/pr-group` repository.

## Not part of the mirror

Hand-written fork docs coexist in this directory (currently `macos-packaging.md`).
Mirror refreshes must exclude them — they are owned in-repo, not in the workspace.
