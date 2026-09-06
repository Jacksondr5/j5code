# Archive-flow design session — rulings record (2026-08-29)

Jackson + UI/UX design agent; dogfood-v0 UX workstream (area 7), closing
the day's sequence (SB → IB → TA → AR). Scope: the human UI of agent/Crew
archive — giving the settled law (R1, R14/R15, R19, J1–J3, IB6) its
moment. Mockup approved in the design workspace
(`product/archive-flow/`). Feature doc of record:
[`../product/features/archive-flow.md`](../product/features/archive-flow.md).

| ID  | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AR1 | **Entry via the existing thread action menu** (v0). Roster row actions reuse the same dialog when they arrive (SB6 v-next).                                                                                                                                                                                                                                                                                                                                                     |
| AR2 | **Pre-archive read, unknowns render as unknown.** Before the dialog: open inbound asks (sender, urgency, intent, age), open outbound asks, placement subtree (A6 cascade). A failed read renders "couldn't check", never an empty list (never-guess).                                                                                                                                                                                                                           |
| AR3 | **The warning dialog appears only when facts warrant it.** Clean agent (no obligations, no children) archives with no dialog, upstream-style. Otherwise: subtree line ("also archives N agents placed under it" + names), the waiting-on-this-agent list (count AND list — J1), the outbound list (marked dropped), an R15 reassurance line (worktrees/branches/PRs survive; cleanup is separate), and one destructive-styled confirm — loud, not annoying; no type-to-confirm. |
| AR4 | **Aftermath.** Agent waiters receive R1 terminal notices rendered per TA3 ("Platform notice · ⟨agent⟩ was archived — your ask was dropped, do not retry"); a human's inbox item leaves immediately (IB6 — this dialog IS the loud moment that ruling leans on). Nothing is deleted anywhere.                                                                                                                                                                                    |

## Dependencies and deferred

- The dialog ships ahead of A9: it warns truthfully today; the terminal
  notices to waiters are A9's build. Subtree facts come from A6's
  placement service; a small client-facing pre-archive read is needed.
- Squadron archive: no archive op exists on the entity; SC4-later.
- Open Memos join this dialog as a third section when Memos ship (R31);
  the layout leaves room.
