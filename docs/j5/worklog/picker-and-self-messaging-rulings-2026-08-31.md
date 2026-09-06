# Two rulings from the #20 acceptance pass (2026-08-31)

Jackson + Product lead, async in the Product thread; relayed for framing by the Director after Jackson's #20 live acceptance pass (the flow passed — both items are forward questions from it). Both framed by Product with recommendations; Jackson ruled "agree" on each, unamended.

## 1. E7 — the Squadron is the unit of user choice

Jackson's observation in the flow: the new-thread project picker (command palette, projects list) still fronts T3's folder-as-container shape — "the squadron becomes the main thing the user picks between." Ruled as a general principle rather than a surface list, recorded as **E7** in [`features/squadron.md`](../product/features/squadron.md): every context-picking surface offers Squadrons; "project" stops being a user-facing noun (stays DV1 substrate); folders are attributes inside the flow, never a peer choice; pickers key off Registrar truth (the two-Squadrons-one-folder criterion restated for the UI). First converted surfaces: new-thread flow AND command palette (the sub-call, ruled yes); the rest via an inventory sweep riding the build ticket. Director scopes the build home.

## 2. Self-messaging: identity hints + fail-closed validation

Live-test failure: an agent asked to message "the other agent" messaged itself — an identity gap, not a discipline gap. Ruled: all three layers, recorded as dated contract revisions in [`a2a/agent-tools.md`](../product/a2a/agent-tools.md):

- `list_participants` marks the caller's own row **`self`** (adopts the prior art's marker; composes with the `display_name` revision).
- The spawned agent's first-turn context states its own participant id + Squadron as platform-provided **facts** (same class as envelope sender identity; the spawner's brief untouched).
- `send_message` **rejects receiver == sender fail-closed** — self-send is never legitimate (self-Exchange is degenerate; notes-to-self are Memos, future-self triggers are `schedule_task`); the error names the caller's own id and the next commands per the toolsmith rule.

Routing: Director indicated the A2S surface lane for item 2; item 1's build home scoped by the Director.
