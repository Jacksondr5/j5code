---
title: "SQ1 — Squadron creation surface & composer context (phase-3 minimal)"
kind: ticket
status: 0
---

# SQ1 — Squadron creation surface

**Governing artifacts:** `../../product/features/squadron.md` §Creation UX (SC1–SC4, definition-of-record, as amended by SB3), **`../../product/dogfood-v0.md` (DV1–DV3 — the single home for v0 overrides; it WINS over feature docs for this build)**, session trail `../squadron-creation-session-2026-08-24.md`, `../dogfood-v0.md` §Phase-3 prerequisite. Mockups in the design workspace (`product/squadron-creation-mockups/`) are decision aids, not pixel specs. Backend receiving contract: the Registrar (PR #10) — creation-time attachment of a thread to an explicit **existing** Squadron, once, immutably.

## Goal

SC4's phase-3 minimal line as cut by DV1–DV3, working in the app: Jackson can create a Squadron (name + one folder), scope the sidebar to it via the Squadron scope dropdown (SB3), and create agents whose Squadron comes from that scope context — so his solo dogfood (phase 3) starts at a real creation flow instead of a wall.

## Scope (SC4 "in" — nothing more)

- **Create Squadron** (SC2 as cut by DV1/DV2): name AND **exactly one folder** required; description optional. The folder is a Squadron→project **reference — never identity** — reusing the existing project machinery; folder picked via the existing open/clone affordances, no new picker. The relation is **stored list-ready** (join or list-shaped column) so the multi-folder milestone lifts a cap, not migrates a concept. Name-only creation is a DV2 named casualty — do not build it.
- **First-run gate** (SC2): first run gates on creating the first Squadron; the gate states plainly that agents need a home and asks for a name plus one folder (DV2). **No auto-created "Default" Squadron anywhere.**
- **Squadron scope dropdown** (SC3 _as amended 2026-08-29, SB3 — [session record](../sidebar-roster-session-2026-08-29.md)_): upstream's project-scope dropdown becomes a Squadron scope dropdown; the sidebar is scoped, never grouped.
- **Composer context inheritance** (SC3): heading becomes "What should we build in _⟨Squadron⟩_?"; explicit **Squadron chip** in the sub-bar beside the worktree row — visible, changeable until send, immutable after. What the chip shows at send is exactly what the Registrar receives. The inherited context comes from the scope-dropdown selection (SC3 as amended).
- **Worktree row** (SC1 as cut by DV1/DV3): offers the Squadron's single folder. "Browse elsewhere…" ships only if project reuse makes it cheap; otherwise it goes to the backlog, not onto the critical path (DV3 — the never-a-wall principle is end-state law, untouched). No permission semantics, no pre-provisioning; worktrees stay per-agent.
- Agent-spawned agents see none of this: they inherit the spawner's Squadron (R21) through the existing path.

## Non-negotiable DV1 guards (build-blocking)

- Squadron membership is **Registrar-assigned, never derived from the project reference** — no code path may infer membership from the folder.
- **Two Squadrons over the same folder must work** — keying Squadron off project is the named trap; this is v0 acceptance, not a later feature.
- **Squadron-first creation** (standing guard): name the work, then attach the folder. Do NOT reuse the project-creation flow wholesale — open-folder-then-it's-a-Squadron rebuilds T3's 1:1 shape with a rename.

## Out of scope (SC4 "later" and "never")

Later: Squadron archive UX, colors/avatars, clone-from-URL niceties, migration of pre-Squadron T3 projects, dashboard consequences of targeting. Never here: cross-machine targeting (item 5, X1), anything boundary-shaped (E1), permission semantics, folder pre-provisioning.

## FORK.md discipline — read before building

This ticket touches upstream UI surfaces (sidebar structure, composer, first-run flow) more deeply than any J5 work so far. Substance goes in new `j5/` files; every append to an upstream file is an enumerated integration case requiring **per-instance Director authorization with file/line anchors before writing it**. Expect the seam-mapping step first: Builder proposes exact anchors, Director authorizes, inventory updated in the same PR. Coordinate with A4's already-authorized `SidebarChrome.tsx` append so the two sidebar seams compose instead of colliding.

## Dependencies

Registrar merged (#10). A4 merged or in-flight coordination on the sidebar seam. Staff when lane capacity allows — phases 1–2 (A4/A9, then A10+A8) keep priority; SQ1 must merge before phase 3 begins.

## Integration carry rule

FORK exception numbers are allocated by landing order. During an isolated SQ1 carry, retain the SQ1 cases even if another lane's case is absent from the worktree. On a later PR/rebase conflict, resolve mechanically by union: retain every already-landed lane and the SQ1 cases, renumbering only by landing order; never drop another lane's case.

## Acceptance

End-to-end in the dev app: fresh state → first-run gate forces Squadron creation (name + one folder; name-only correctly refused per DV2) → **second Squadron created over the SAME folder — both fully work (DV1 guard b, the headline check)** → both appear in the Squadron scope dropdown and scoping filters the thread list → selecting a Squadron scope and composing shows the heading + chip; chip changeable until send, immutable after → the created agent's thread is registered to the chip's exact Squadron (assert the Registrar-recorded home matches, and that membership was Registrar-assigned, not project-derived). Schema check: the folder relation round-trips a second folder at the storage layer (list-ready, DV1 guard c) even though the UI caps at one. Negative controls: no code path auto-creates a Squadron; a send with no Squadron context is impossible by construction (the composer always carries one). Baseline suite green.
