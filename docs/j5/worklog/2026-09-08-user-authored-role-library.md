---
title: "User-authored Role library (2026-09-08)"
kind: record
---

> **Record.** The decision below was written into the product decision log on 2026-09-08; the log was retired on 2026-09-09 and the settled behavior now lives in the [persona contract](../product/agent-personas/index.md) and the [Roles definition](../product/features/roles.md). Kept as the story of how the built-in catalog became a user-authored library.

# User-authored Role library (2026-09-08)

Jacksondr5's [PR #75 review](https://github.com/Jacksondr5/j5code/pull/75) requires portable, user-authored personas and reconciliation with existing Roles documentation. Bryant approved folder loading first, with existing orchestrator activation; in-app editing and direct human selection are follow-up work. The [persona contract](../product/agent-personas/index.md) implements the [Role](../product/features/roles.md) concept rather than defining a competing product entity.

The eleven supplied personas become editable examples using the same format as imported files. Definitions support custom ids, author versions, instruction content, and environment-local source folders. Launch snapshots preserve their content independently of later edits. Role behavior remains guidance; only explicitly supported runtime controls are enforcement guarantees. Unsupported diagnostic and publication modes remain blocked. Changes to T3-owned integration points are inventoried in `FORK.md`.

The dated 2026-09-02 and 2026-09-03 decisions below remain historical context. Their closed registry, blanket action-enforcement claims, permanent orchestrator-only UX, and phase-completion implications are superseded by this revision. Routing remains a primary/fallback pair for this delivery slice. The August product direction for in-app authoring and human spawning remains planned, not implemented by this revision.
