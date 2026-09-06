# Human-addressed sends: asks only (2026-09-02)

Jackson + Product lead, in the Product thread inside J5 (first ruling made from inside the product). Origin: issue #44 — plain messages to a person were found invisible in Jackson's 2026-09-01 session (durable ledger records, no human surface), then reproduced by two migrated agents including Product itself; PR #57 proposed a truthful "invisible in v0" description plus an A/B/C disposition for where such messages should eventually live (A: sender's thread card; B: an inbox lane; C: no ruling). The Director relayed the options; Product brought A as the recommendation.

## The ruling — option D, superseding A/B/C

Jackson: prevent plain messages to a human entirely — agents may only send a person asks (or replies). His reasoning: agents on the chatty end of the spectrum would use a plain send and flood the person; if they have something to say, they say it where the human is already reading — their own thread, or their Captain/spawner's.

Product's concurrence added the sharper argument: a plain message to a person carries **no information the sender's thread does not already carry**, so the verb's only distinctive property is feeling like a notification while doing nothing — the exact trap three agents fell into. The rule is also the sender-side mirror of inbox purity (R5/IB1): if the inbox shows only asks, the tool must accept only asks toward a person, or the contract lies in one direction.

Precisions ruled with it:

1. **Exactly:** agent→human send = ask (`expect_reply` + `intent` + `urgency`) or reply (`exchange_id`); anything else refused fail-closed, error naming both legal moves and the own-thread alternative. Address book: human row `can_receive_message: false, can_open_exchange: true` (today's `true/true` is lying).
2. **Permanent law**, not a dogfood-v0 override — the reasoning does not expire.
3. **Not routing:** R22 stands (Captains never routers; agent↔agent plain sends fully open). The Captain/spawner is the holder of the work context and judges what rises to an ask; the human reads that thread when engaged.

4. **Corollary confirmed same day (surfaced by PR #57's implementation, Director-accepted, Product-confirmed as the intended reading):** a second ask to a person while that pair's exchange is open is refused rather than coalesced — under D a follow-up delivery to a person is a plain delivery. This resolves #45 part 3 by refusal instead of a new inbox surface: the item the person sees is always the whole ask, and amending it is loud (clear_own_ask, then re-ask with the combined content). Parts 1–2 of #45 (sender-card overclaim; coalescing told to the sender) remain open — they are agent↔agent concerns and coalescing there is untouched.

Accepted cost, named at ruling: chatty agents will convert check-ins into low-urgency asks. Judged the right failure mode — visible, countable per sender, fixed in briefs/Roles (operator content), where the prior-art fleet fixed the same thing. Invisible traffic was unfixable because nobody could see the pattern.

Recommended, separate, **not ruled**: rename urgency `fyi` → `whenever` (an ask urgency named "no reply needed" mislabels an obligation; levels answer "when do you need my answer": blocking / soon / whenever). Friction-list entry exists (ab7b7b2cf).

## Consequences for open work

- **#44** closes when the refusal, the capability-flag change, and the amended description land together — not on #57 as written.
- **#57** is superseded in wording: "plain sends to a person are invisible in v0" becomes "a plain send to a person is refused" — rework, not merge, at the Director's disposition.
- Records updated: `product/a2a/agent-tools.md` (send_message description + revision; list_participants revision), `product/features/inbox.md` (sender-side mirror section).
