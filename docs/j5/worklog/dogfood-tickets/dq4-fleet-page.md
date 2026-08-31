---
title: "DQ4 — Fleet page + provenance sidebar membership (paired, ship together)"
kind: ticket
status: 0
---

# DQ4 — Fleet page pair

**Reserved for J5-native dogfood work — meaty tier (natural first-crew ticket).** Design is definition-of-record in this repo.

## Context

`docs/j5/product/features/sidebar-and-roster.md` §SB6 defines the Fleet page (full-width roster: placement tree grouped by Squadron, status/open-asks/last-activity columns, rail-footer entry with alert badge, unknowns render as `?`), and §SB5 the provenance-based sidebar membership rule (human-created agents show; agent-spawned Peer Agents are roster-only; pin/hide overrides). **Pairing constraint (design ruling): these ship together or not at all** — hiding agents without the roster existing makes them unreachable-by-eye.

## Scope

Both SB5 + SB6 behaviors per the feature doc. Data: placement + provenance from the merged placement substrate; open-ask counts and last-activity need client-facing reads that DO NOT EXIST yet — building them (bounded, absorbable-by-A5-later shapes; see `docs/j5/worklog/dogfood-tickets/b6-client-reads.md` for the established read discipline) is in scope. The human-only re-parent mechanism and orphan-policy surfacing are NOT in scope (each has its own recorded future path — see `docs/j5/worklog/dogfood-v0.md` queued items).

## Acceptance

Roster renders every agent grouped by Squadron and indented by placement with truthful columns (unknowns as `?`, never guessed); sidebar membership follows provenance with pin/hide both directions; an agent-spawned Peer Agent is roster-reachable while sidebar-hidden (the pairing constraint proven); rail-footer entry + badge counts measured facts only; baseline green.
