---
title: "A6 — Spawn placement + provenance (D10)"
kind: ticket
status: 0
---

# A6 — Spawn placement + provenance

**Governing artifacts:** `../../../index.md` D10 (the three-relationship decoupling — read its full cell), `../../index.md` (§Agent tool surface, last paragraph). Base: `j5/main` @ `e7597dac8`.

## Goal

Org placement stops lying: where an agent _displays_ is decoupled from who _spawned_ it and who it _owes results to_.

<user_quoted_section>Scope clarification (Director, 2026-08-17, resolving the group's negative FORK-feasibility audit): A6 is built by composition, not modification — no upstream contract/core edits are authorized. The placement parameter lives on a J5-owned creation wrapper tool (J5 MCP toolkit, beside send_message) that composes the unmodified upstream creation path + a J5 placement-store write; provenance derives read-only from upstream's immutable thread.created lineage; cascade = J5 commands that walk the J5 placement tree and dispatch existing upstream per-thread stop/archive commands (upstream-native single-thread ops stay thread-scoped — documented boundary). Native-UI creations bypassing the wrapper get default placement (spawner/root) — accepted v1 bound. A Builder feasibility spike on wrapper reachability + cascade dispatch gates implementation; if composition also fails additively, A6 defers (Jackson decides with evidence).</user_quoted_section>

## Scope

- **Provenance**: spawned-by recorded automatically and immutably at creation (ledger event; part of the participant model).
- **Placement parameter** on agent/thread creation tools: default = spawner; `sibling | other-parent | root` allowed at spawn. A mutable display-tree pointer, stored J5-side (new table/projection) — v2's delegation machinery untouched (result-binding stays with the delegator regardless of placement).
- **Re-parenting**: human-only in v1 (a server command the UI can call; no agent-callable tool). Cycle-checked — **correction (spike finding, 2026-08-17): v2 has NO cycle-check to reuse at our pin (its lineage is immutable, therefore acyclic by construction); J5 placement is mutable and needs its own explicit cycle-check algorithm**, tested with the negative control below.
- **Cascade semantics**: stop/archive cascades follow _placement_, not provenance — document this in the command contracts.
- `list_participants` rows expose placement + provenance so callers and future UI read the same truth.

## Out of scope

Teams/role objects (item 3 — placement ≠ team membership). Agent-initiated re-parenting. Display-tree UI (item 4).

## Dependencies

**A1** (ledger + participant model). Independent of A2–A5; schedule opportunistically.

## Provenance boundary (Director ruling, 2026-08-16)

Provenance is typed and never coerced:

| Kind          | Authoritative source                                                                  | Default placement                                                                    |
| ------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `spawned-by`  | delegated child lineage, or the calling participant recorded by a J5 creation wrapper | under the spawner                                                                    |
| `forked-from` | immutable upstream fork lineage and its source participant                            | sibling of the source (the source's current placement parent; root when it has none) |
| `unknown`     | ordinary/native creation, legacy null lineage, or an unobserved creation path         | root                                                                                 |

`thread.created.record` timeline breadcrumbs are not provenance. A non-null lineage parent is also
not enough: `relationshipToParent` distinguishes `subagent` (`spawned-by`) from `fork`
(`forked-from`). Fork placement is a snapshot at fork creation, not a live alias to the source.

Cascade commands walk the mutable placement tree only. Therefore stopping or archiving a source
does not cascade to forks placed as its siblings; provenance and upstream result/delegation bindings
remain unchanged.

## Acceptance

Spawn with each placement value lands the agent in the right display position with provenance intact (provenance ≠ placement proven by a sibling-placement spawn); re-parent command works, refuses cycles (negative control: an attempted cycle must be rejected with a state-naming error), and refuses agent callers; cascade follows placement in a scripted two-tree fixture; baseline suite green.
