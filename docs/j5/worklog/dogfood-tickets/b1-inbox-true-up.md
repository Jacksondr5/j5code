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

## Closure-envelope invariant handoff (2026-08-30)

Role-based closed-envelope selection is truthful under the current one-reply-closes invariant. `SendService` refuses a cross-Squadron reply when it cannot persist the matching `exchange.closed` fact, so that state cannot silently produce a closed envelope. If cross-Squadron replies become reachable, or any second role-without-closure path appears, re-plumb envelope selection to the persisted closure fact rather than adding another `exchangeRole` exception.

## Findings #135–#141 recovery record (2026-08-31)

- **MCP command namespace:** the only host state database, `/Users/jackson/.t3/userdata/state.sqlite`, contains none of the J5 communication receipt, event, or delivery tables, and this dedicated worktree has no state database. The unqualified `send_message` receipt cohort is therefore nonexistent: zero receipts, events, or deliveries require compatibility recovery. Both mutating tools now use explicit tool-name namespaces. There is no automatic fallback to the unqualified form; if such a receipt is discovered later, stop and audit that database rather than silently replaying or duplicating it.
- **Own-open-asks read:** no agent-facing read exists at this head. The J5 MCP toolkit exposes `send_message`, `list_participants`, and `clear_own_ask`; authenticated J5 HTTP routes expose the human inbox, Squadron management, and thread homes. The retained thread reads do not expose Exchange obligations. The unknown-exchange error therefore names this absence and accepts only an `exchange_id` retained from the original `send_message` result. A discoverable own-open-asks read remains a separate product/tooling gap; this ticket does not invent one.
- **Clear replay versus collision:** replaying the same `clear_own_ask` command returns the original `sender-cleared` result and original `closedAt` without another event. A command receipt bound to a different request is a typed conflict and directs the caller to a unique `client_request_id`; it never claims the Exchange was cleared.
