# Inbox design session — rulings record (2026-08-29)

Jackson + UI/UX design agent; dogfood-v0 UX workstream (area 5 of the
dogfood UX map), same-day continuation of the sidebar/roster session
(SB1–SB7). Scope: the human surface of the obligation queue — the
dogfood definition's heart ("asks land in the in-app inbox; the verbatim
answer closes the exchange"). Backend contract: A4's inbox projection and
idempotent `answer` API; A4's dev-grade `/inbox` page proved the
mechanics. Mockup approved by Jackson in the design workspace
(`product/inbox/mockups/`), styled against real app references. Feature
doc of record: [`../product/features/inbox.md`](../product/features/inbox.md).

| ID  | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IB1 | **Two reply flows, both first-class.** (a) _Quick reply from the item_: the user answers in place; the platform clears the ask and **tells the agent the platform did so** (reply-delivery envelope, R3). (b) _Go to the agent_: "Open thread →" jumps to the asker's thread; the user replies as normal chat; **the agent clears its own ask via tool** once conversation resolved it (sender-judges-completeness applied to withdrawal).                                                            |
| IB2 | **Placement: bell + numbered badge beside the rail logo; main-view Inbox page.** The bell carries the open count and opens the page; no other badge locations in v0. Start with a full page, iterate smaller as the product matures.                                                                                                                                                                                                                                                                  |
| IB3 | **Item anatomy: sender, Squadron, intent (subject line), message, urgency, time-since-opened** (R25 fact, e.g. "open 4h"). Urgency is the loudest element (blocking/soon/fyi). Asker's-current-state column dropped for v0 — challenged on value; determinable from silence facts and orthogonal to urgency in principle, but marginal; revisit post-A10 if dogfooding wants it.                                                                                                                      |
| IB4 | **Ordering: urgency (blocking → soon → fyi), then age** — A4's list order, unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| IB5 | **Answered items recede into an Answered shelf** (settled-style), collapsed at the bottom.                                                                                                                                                                                                                                                                                                                                                                                                            |
| IB6 | **Dropped asks leave the inbox immediately.** The archive-time warning (R1/J1–J3) is the loud moment; once the archiver confirmed past the open-ask warning, holding a corpse in the queue is clutter, not signal. No terminal rows. _Designer note, recorded not relitigated: when an agent archives a Crew (R19), the warning went to the archiving agent — an ask can leave the human's inbox without the human seeing a warning. Accepted for v0 (no Crews yet); revisit if dogfood surfaces it._ |
| IB7 | **v0 scope: agent-sent asks only; the inbox is not Squadron-scoped.** The platform-alerts lane (SB7) is post-v0 — the Fleet page carries fallen-over agents meanwhile. Obligations are global to the person (person-scoped per R9/R29); each item wears its Squadron; the rail's scope dropdown governs the thread list only.                                                                                                                                                                         |

## Platform dependency discovered (needs an A-series home)

IB1's flow (b) requires an **agent-facing clear-own-ask tool** — closing
one's own open exchange without a reply message, with a ledger event.
Nothing ships this today; until it exists, in-thread-resolved asks linger
open in the queue (known gap). Flagged to Jackson for the Director.

## Handoff note

The implementing dev owns technical design within these rulings. A4's
`answer` API, urgency-ordered `list`, and the inbox projection are the
receiving contract; the page replaces A4's dev-grade surface (which
required typing a raw person id — the real page resolves the local
operator's person id silently).
