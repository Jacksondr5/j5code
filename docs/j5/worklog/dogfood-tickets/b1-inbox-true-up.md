---
title: "B1 — Inbox surface true-up to IB1–IB7 (post-#11)"
kind: ticket
status: 0
---

# B1 — Inbox true-up

**Governing artifacts:** `../../product/features/inbox.md` (IB1–IB7, definition-of-record), gap-analysis conformance report (Director log 2026-08-30), `../../product/dogfood-v0.md`. Base: `j5/main` after PR #11 merges — #11's projection/answer API is the contract; this ticket reshapes the view and closes two platform gaps.

## Scope

- **IB2 entry point:** replace the sidebar-footer `Inbox` entry with a bell icon + numbered open-count badge beside the rail logo → main-view page. Count may poll (no push home exists yet).
- **IB3 presentation:** urgency is the loudest element; intent as subject; collapsed header → expand to reveal body + reply; time-since-opened as a measured fact ("open 4h"), never absolute-only.
- **IB1 flow 1 completion — closed-exchange envelope variant:** the reply-delivery envelope must tell the asker the platform closed the exchange; today it renders the standard reply instruction against a closed exchange (gap-analysis finding). New envelope variant in the versioned config.
- **IB1 flow 2:** "Open thread →" per item (sender-participant → threadId resolution from ledger membership), plus the **clear-own-ask tool** (agent closes its own open exchange without a reply; evented, ledger-recorded; MCP-surface contract per the architect's agent-tools doc). Note: a `j5/substrate-clear-own-ask` spike branch exists locally — evaluate for adoption rather than rebuilding blind.
- **IB5:** Answered shelf (backend state already exists; add the server list param if it returns open-only, then the shelf UI). Deferrable into the dogfood period if the cut demands — coordinate with Director before dropping.
- **Silent local-operator resolution:** remove the manual person-id field; resolve via the existing registry read.

## Out of scope

Alerts lane (post-v0). Push delivery for the badge. Dropped-ask terminal rendering beyond what A9's facts provide (IB6 composes when A9 lands).

## Seams

Bell+badge placement and the footer-entry removal are B1's authorized SidebarChrome/rail zone (pre-partitioned; scope dropdown belongs to SQ1, roster entry to the Fleet ticket). Exact anchors to the Director before writing.

## Acceptance

Bell + accurate open count visible from any view; expanding an item reveals body + inline answer; answer closes the exchange and the asker's delivery envelope states the exchange is closed (byte-equal answer preserved; envelope asserts no reply instruction); "Open thread →" lands on the asker's thread; an agent invoking clear-own-ask removes its item from the inbox with a ledger event and no reply; urgency ordering and "open Nh" rendering verified; manual person-id field gone. UI screenshots on the PR. Baseline suite green.
