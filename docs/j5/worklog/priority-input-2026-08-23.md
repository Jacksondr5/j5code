# Priority input for the reprioritization — Product lead, 2026-08-23

One page for Jackson + the Manager. State as of the design review (R1–R35, commits
`3c8470eba`/`835700860`) and A1–A3 landed.

## Where everything stands

| Workstream           | State                                                                                                                                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2A core (item 2)    | A1–A3 built. A4–A7 remain. R1–R35 touched the plan: A4 amended for multi-human (done, `c3a20ffd8`); A6 rescope pending the Manager's disposition ruling; R2/R3/R10/R25 touch closure semantics and timestamps                                        |
| Roles/Crews (item 3) | Session-ready with a rich inheritance. Still open: SOUL-vs-AGENTS-vs-bootstrap content model, authoring-time counterpart syntax, role claims/dedup, example templates (user-space content), file discovery/versioning UX, Crew schema + brief travel |
| PR pane (4a)         | Posted as issue #6, multi-environment constraint attached; the parallel human-engineer track, unstaffed                                                                                                                                              |
| New candidates       | Playbooks (R27 fences set), Memos (R31–R35 spec'd), Shared Squadrons (vision-stage; multi-human invariant already in force protecting the door)                                                                                                      |

## Recommended order, with rationale

1. **True-up pass on the A2A plan against R1–R35, then finish A4–A7.** One
   reconciliation pass is cheaper than per-ticket discoveries (the Design
   Review agent flagged the same). Everything else stacks on this core: Memos
   is ledger-adjacent, Playbook fan-out rides messaging, and the item-4
   dashboard needs A5's graph read API. A4's multi-human amendment is already
   applied; A6 needs only the Manager's rescope ruling to proceed.
2. **Roles/Crews: design session, then build.** The remaining open items are
   scoped and small enough for one session. This is the differentiator (the
   definition layer nobody has), and the canonical demo — a PR Group running
   as a Crew on the platform — needs Roles + Crews + the A2A core together.
3. **Memos.** Small, fully spec'd, aimed at an observed failure (deferred
   items dropping out of coordinator context). Natural to build right after
   A4 while the inbox/ledger machinery is warm. Validation task attached:
   check the design against the triage follow-up experiment if it reports
   (Memos was designed ahead of that data).
4. **Playbooks.** After Crews exist and a real Crew has run without one — the
   fences are set (mechanism-is-platform, content-is-user, no shipped
   default, linear before DAG, agent-declared advancement), but
   incubate-before-codify argues for feeling the pain first.
5. **Shared Squadrons.** Stay vision-stage. The multi-human invariant and the
   peer-registry seam (X4) already protect the door; designing further now
   buys nothing.

**Parallel human track:** the PR pane (issue #6) is independent of all of the
above and staffable any time.

## Process items to close in the same conversation

- **Ratify repo-direct docs authoring** and formally retire the
  artifact-mirror pipeline (observed convention since the review; README still
  carries mirror framing).
- **Rule on A6's disposition** (rescope recommended: keep provenance +
  human-only re-parent, delete the spawn-time placement parameter per R21).
