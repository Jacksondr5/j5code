---
title: "SQ1 — Squadron creation surface & composer context (phase-3 minimal)"
kind: ticket
status: 0
---

# SQ1 — Squadron creation surface

**Governing artifacts:** `../../product/features/squadron.md` §Creation UX (SC1–SC4, definition-of-record), session trail `../squadron-creation-session-2026-08-24.md`, `../dogfood-v0.md` §Phase-3 prerequisite. Mockups in the design workspace (`product/squadron-creation-mockups/`) are decision aids, not pixel specs. Backend receiving contract: the Registrar (PR #10) — creation-time attachment of a thread to an explicit **existing** Squadron, once, immutably.

## Goal

SC4's phase-3 minimal line, working in the app: Jackson can create a Squadron, grow its folder list, navigate a Squadron-grouped sidebar, and create agents whose Squadron comes from navigation context — so his solo dogfood (phase 3) starts at a real creation flow instead of a wall.

## Scope (SC4 "in" — nothing more)

- **Create Squadron** (SC2): name required; description and folders optional, addable later; folders picked via the **existing** open/clone affordances — no new picker. A deliberately small act.
- **First-run gate** (SC2): first run gates on creating the first Squadron; the gate states plainly that agents need a home and that name-only is enough. **No auto-created "Default" Squadron anywhere.**
- **Edit folder list** after creation (SC1: targets legitimately grow).
- **Squadron scope dropdown** (SC3 _as amended 2026-08-29, SB3 — [session record](../sidebar-roster-session-2026-08-29.md)_): upstream's project-scope dropdown becomes a Squadron scope dropdown; the sidebar is scoped, never grouped.
- **Composer context inheritance** (SC3): heading becomes "What should we build in _⟨Squadron⟩_?"; explicit **Squadron chip** in the sub-bar beside the worktree row — visible, changeable until send, immutable after. What the chip shows at send is exactly what the Registrar receives. The inherited context comes from the scope-dropdown selection (SC3 as amended).
- **Palette-first worktree row** (SC1): the Squadron's folders first, labeled, with the rest of the machine reachable below a "Browse elsewhere…" separator. One mechanical consequence only — no permission semantics, no pre-provisioning; worktrees stay per-agent.
- Agent-spawned agents see none of this: they inherit the spawner's Squadron (R21) through the existing path.

## Out of scope (SC4 "later" and "never")

Later: Squadron archive UX, colors/avatars, clone-from-URL niceties, migration of pre-Squadron T3 projects, dashboard consequences of targeting. Never here: cross-machine targeting (item 5, X1), anything boundary-shaped (E1), permission semantics, folder pre-provisioning.

## FORK.md discipline — read before building

This ticket touches upstream UI surfaces (sidebar structure, composer, first-run flow) more deeply than any J5 work so far. Substance goes in new `j5/` files; every append to an upstream file is an enumerated integration case requiring **per-instance Director authorization with file/line anchors before writing it**. Expect the seam-mapping step first: Builder proposes exact anchors, Director authorizes, inventory updated in the same PR. Coordinate with A4's already-authorized `SidebarChrome.tsx` append so the two sidebar seams compose instead of colliding.

## Dependencies

Registrar merged (#10). A4 merged or in-flight coordination on the sidebar seam. Staff when lane capacity allows — phases 1–2 (A4/A9, then A10+A8) keep priority; SQ1 must merge before phase 3 begins.

## Acceptance

End-to-end in the dev app: fresh state → first-run gate forces Squadron creation and name-only succeeds → second Squadron created with folders via the existing pickers → both appear in the Squadron scope dropdown and scoping filters the thread list → selecting a Squadron scope and composing shows the heading + chip; chip changeable until send, immutable after → the created agent's thread is registered to the chip's exact Squadron (assert the Registrar-recorded home matches). Many-to-many proof: two Squadrons targeting the same folder AND one Squadron targeting two folders, both working. Worktree row lists the Squadron's folders first with "Browse elsewhere…" reaching an unlisted folder. Negative controls: no code path auto-creates a Squadron; a send with no Squadron context is impossible by construction (the composer always carries one). Baseline suite green.
