---
title: "B6 — Small client-read endpoints (labels, names, counts)"
kind: ticket
status: 0
---

# B6 — Client reads bundle

**Governing artifacts:** design dependency map (sidebar-and-roster.md, inbox.md, thread-a2a-rendering.md consumers), gap-analysis net-new list. Deliberately NOT A5: these are small targeted reads the wave-1 UI lanes need now; A5's graph API supersedes or absorbs them later without breaking consumers.

## Scope

- **Sidebar row Squadron labels:** participant → home-Squadron (id + name) read (ledger membership exists server-side; expose a client-facing read).
- **Sender-name resolution** for TA rendering and inbox items (participant id → display identity).
- **Inbox open-count** for B1's bell badge (cheap count endpoint; poll-friendly).
- All J5-owned routes on the existing authenticated routes layer (#11's `makeRoutesLayer` pattern); read-only; no new auth surface.

## Out of scope

Per-participant last-activity and open-exchange counts (A5 scope — roster consumers, not wave-1). Pre-archive read (rides A9). Any write.

## Acceptance

Each read returns correct data against seeded multi-Squadron fixtures; unknowns render explicitly (never guessed); consumers (B1/B3 lanes) verified against the live endpoints in the dev app; routes ride the existing auth middleware (negative control: unauthenticated request refused). Baseline suite green.

## B6 implementation contract

- The raw HTTP module remains unregistered until SQ1 supplies the authenticated J5-routes aggregate. Its injected path slots are `participantHome`, `participantIdentities`, and `openInboxCount`, all `POST`; the aggregate selects their concrete URLs. Home and identity both accept `{ participantIds: ParticipantId[] }`; IDs stay opaque, exact duplicates collapse server-side, and both responses are total and in first-occurrence request order. Home returns `{ entries: [{ participantId, home: { kind: 'known', squadron: { id, name } } | { kind: 'unknown' } }] }`; identity returns `{ entries: [{ participantId, identity: { kind: 'known', displayName } | { kind: 'unknown' } }] }`. Empty input returns `{ entries: [] }`; count accepts `{ personId?: ParticipantId }`.
- Home resolution returns the participant's chronologically earliest immutable agent `participant.joined` Squadron (`id` and `name`), never active membership; ties order by Squadron then its local event sequence. Sender identity uses that same ranked join history plus the corresponding thread title; missing or blank titles yield `{ kind: 'unknown' }`, which clients render as the literal participant ID.
- The open-count accepts an optional `personId` and delegates resolution exactly to A4's public `resolvePersonId`. Its predicate is identical to A4 list semantics: both `j5_a2a_human_inbox.status` and joined `j5_a2a_exchange.status` must be literal `'open'`. The count costs O(open rows for the resolved person); it has no counter or claim of constant work.
- B6 intentionally reports an absent local-operator resolution as a `404` missing client read, unlike A4's raw route, and reports response-schema encoding failures as `500`: B6 validates server-produced data after the request boundary. This lane does not alter or share A4's HTTP helpers.
- Home and identity reads chunk exact-deduped visible participant sets into at most 900 bound IDs per SQLite query, then reassemble the total first-occurrence response. This avoids a parameter-limit failure without creating per-row requests or changing B3 semantics.
- The aggregate registers `POST /api/j5/a2a/client-reads/participant-homes`, `POST /api/j5/a2a/client-reads/participant-identities`, and `POST /api/j5/a2a/client-reads/open-count`; all routes are authenticated read-scope routes. Migration 010 contains only the partial open-inbox person index with manifest/order and index assertions. Real-client B1/B3 dev-app verification remains split acceptance.
