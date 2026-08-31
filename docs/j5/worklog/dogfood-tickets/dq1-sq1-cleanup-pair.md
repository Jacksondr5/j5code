---
title: "DQ1 — SQ1 follow-up pair: honest read-failure surfacing + dead prop removal"
kind: ticket
status: 0
---

# DQ1 — Creation-surface cleanup pair

**Reserved for J5-native dogfood work — starter tier.** Fully self-contained: everything needed is in this repo.

## Context

The Squadron creation surface (PR #20) deferred two small findings with rulings on record. Both are inside J5-owned web code; no upstream seams expected.

## Scope

1. **Transient thread-home read failures surface honestly under a selected Squadron scope.** Today a failed `threadId → Registrar-home` batch read can leave scoped sidebar filtering silently degraded. Rule of record: failures surface with state-naming (a visible "scope temporarily unmeasurable"-class treatment), never a silently-empty or silently-unfiltered list. See `docs/j5/product/features/squadron.md` (scope semantics) and the never-guess principle in `docs/j5/product/principles.md`.
2. **Remove the vestigial `projectIds` from SquadronChoice** — display-dead since scope filtering keys on Registrar homes, not folders. Plain dead-code removal (no-dead-code law: `docs/j5/process/pr-groups.md`).

## Acceptance

A simulated read failure renders the named degraded state (test asserts the state, not just absence of crash); the vestigial field is gone with no behavior change (typecheck + focused suite prove it); baseline green.
