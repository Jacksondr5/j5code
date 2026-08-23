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
Note: this tree was reorganized 2026-08-23 (single-doc folders flattened to
`topic.md`, feature docs grouped under `features/`), so its layout no longer
matches the workspace's folder structure — content, not paths, is what mirrors.

## Reading order for newcomers

1. `product/problems.md` — what hurts and what's wanted: the problem statement
   and goals, in Jackson's voice.
2. `product/fleet-vision.md` — why this exists: the operating model and thesis.
3. `product/principles.md` — the beliefs, lenses, and principles: the machine
   that turns the problems and goals into product.
4. `research/synthesis.md` — what we learned from T3 Code and Traycer, and the
   engineering principles adopted from each.
5. `research/jackson-prior-art/fleet-interviews-synthesis.md` — field lessons
   from a real production agent fleet, and the platform/non-platform boundary
   that governs scope decisions.
6. `product/decision-log.md` — every settled product decision, one row each.
7. `product/a2a/` — the A2A (agent-to-agent communication) design: decision
   register, grounding model, and `plan.md` with the milestone plan.
8. `product/features/` — the feature definitions of record (Squadrons, Memos, the PR
   pane; Roles, Crews, and Playbooks to come).

## Contents

- `backlog.md` — the prioritized roadmap.
- `product/features/` — feature definitions of record: `squadron.md`, `memos.md`,
  `pr-pane.md` (more as they're designed).
- `product/` — product designs and decisions: problems & goals, the
  beliefs/lenses/principles machine, decision log, fleet vision, glossary,
  the A2A design + plan, communication graph, cross-device position, and the
  2026-08-21 design-review register that defined Crews/Manifests/Captains.
- `research/` — the studies behind the decisions: T3 Code deep dives (the
  upstream this repo forks), Traycer's A2A/organization model, and the
  prior-art fleet studies. A quarantined, superseded early T3 snapshot was
  deliberately not mirrored.
- `process/` — working-process notes for the agent teams building here.
- `worklog/` — build-time records, kept out of the evergreen docs: the A2A
  implementation tickets with their reviews and retros (`a2a-tickets/`), how
  this fork was established (`fork-setup-plan/` — base pin, rebrand, CI,
  load-test baseline), and PR triage reviews. Historical by nature; read the
  product docs for current truth.

Cross-references between documents use relative paths and survive within this
tree. References to `interviews/` point at the public
`Jacksondr5/pr-group` repository.

## Not part of the mirror

Hand-written fork docs coexist in this directory (currently `macos-packaging.md`).
Mirror refreshes must exclude them — they are owned in-repo, not in the workspace.
