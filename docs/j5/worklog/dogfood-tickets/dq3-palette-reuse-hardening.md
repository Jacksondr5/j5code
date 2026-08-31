---
title: "DQ3 — CommandPalette reuse-or-create identity hardening"
kind: ticket
status: 0
---

# DQ3 — Palette stale-cache hardening

**Reserved for J5-native dogfood work — middle tier.** Deferred-by-ruling hardening; not implicated in any live defect (measured at deferral time).

## Context

The first-run "Add folder" fallback can reach CommandPalette's stale-cache `project.create` even when `ProjectService.bootstrap()` already returns the existing normalized-root project — risking a duplicate project record for the same folder. Deferred from the creation-surface work by ruling (the live defect it was suspected of causing was disproven by DB measurement — exactly one project row existed).

## Scope

Expose reuse-or-create identity so the palette path cannot create a duplicate project for an already-known root: measure the current create path, then either consult the bootstrap/projection state before create, or make create idempotent per normalized root. Protected-file touches (CommandPalette + client/server carrier) follow the FORK.md enumerated-case discipline (`FORK.md` §Sanctioned integration cases) — anchors recorded in the PR.

## Acceptance

Adding an already-known root folder via every palette-reachable path yields the existing project (no duplicate row — DB-level assertion); fresh-folder create unchanged; FORK inventory updated; baseline green.
