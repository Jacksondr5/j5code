---
title: "Archive flow — the warning moment, designed"
kind: spec
---

# Archive flow

Feature definition of record, settled 2026-08-29 with Jackson
([session rulings AR1–AR4](../../worklog/archive-flow-session-2026-08-29.md)).
This is the UI of the law already in force: archive terminates
obligations loudly (R1), Crews archive as units (R14), **archive never
destroys work** (R15), archive-with-open-Exchanges warns with count +
list + explicit confirmation (J1–J3), and a dropped ask leaves the
human's inbox immediately because this warning is the loud moment (IB6).
Approved mockup in the design workspace (`product/archive-flow/`).

## The flow

1. **Entry**: the existing thread action menu (v0); roster actions reuse
   the dialog later.
2. **Pre-archive read**: open asks in both directions + the placement
   subtree. Unknowns render as "couldn't check" — never as an empty,
   reassuring list ([never-guess](../principles.md)).
3. **The dialog — only when facts warrant it.** A clean agent archives
   without ceremony. Otherwise: the subtree line (cascade names), each
   waiting ask with sender/urgency/intent/age, the outbound asks that
   drop, a quiet R15 reassurance (worktrees, branches, PRs survive —
   cleanup is a separate act), and one destructive-styled "Archive
   anyway". One confirm; no type-to-confirm.
4. **Aftermath**: agent waiters get R1 terminal notices rendered as
   muted platform notices (TA3); human inbox items leave immediately
   (IB6); rows leave the active sidebar/roster sets. Nothing is deleted.

## Dependencies

Ships ahead of A9 (the dialog warns truthfully today; waiter notices are
A9's build). Subtree facts from A6 placement; needs a small client-facing
pre-archive read. Squadron archive is out of scope (no archive op exists
on the entity — SC4-later). Open Memos join as a third dialog section
when Memos ship (R31).

## What this feature is not

Not a delete (R15 — nothing in the workspace is touched), not a
seat-level operation (members are never individually archived — R14),
and not a place for platform judgment: every line in the dialog is a
measured fact; whether to proceed is entirely the human's or Captain's
call.
