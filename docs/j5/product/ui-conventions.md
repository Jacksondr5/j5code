---
title: "UI conventions — the design rulings of record"
kind: spec
---

# UI conventions

The design conventions every J5 surface follows, written down once so
they stop living only in transcripts. These are Jackson's rulings, made
in design sessions and live tests between 2026-08-23 and 2026-09-01.
Audience: every future design or build lane on any harness, and human
contributors. Each entry is one rule, its source, and one line of why.
Specifics of any single surface live in the feature docs under
[`features/`](features/); this document never duplicates them. Fleet
process law (staffing, review, evidence) lives in
[`../process/`](../process/) — the standing-rules document there is the
record for process; this one is the record for design.

## How design work happens

1. **WHAT and WHY before HOW.** A session settles what the experience is
   and why before anyone touches mechanism or layout.
   _Source: [Roles/Crews session, 2026-08-23](../worklog/roles-crews-session-2026-08-23.md),
   where Jackson stopped a drift into technical design._
   _Why: mechanism decided first quietly fixes the experience to
   whatever was easiest to build._
2. **Bring options as pictures.** Design alternatives are presented as
   rendered mockups (two to four directions), not prose; Jackson rules
   on sight.
   _Source: working method ruled 2026-08-29,
   [sidebar/roster session](../worklog/sidebar-roster-session-2026-08-29.md);
   applied in every session since._
   _Why: he rules fastest and most accurately on things he can see._
3. **Check mockups against the real app before presenting them.** A
   mockup is styled against screenshots of the running app and its
   actual design tokens, never against memory or an earlier mockup.
   _Source: Jackson's correction during the sidebar round, 2026-08-29
   ("did you capture a screenshot of the existing app as reference
   first?"); round-two mockups were rebuilt from live references._
   _Why: secondhand fidelity drifts — the first round used boxed, bordered
   cards on an app whose rows are borderless and near-black._
4. **Mockups are decision aids, not pixel specs.** The implementing lane
   owns fidelity within the rulings; a mockup shows intent.
   _Source: [Squadron creation session, 2026-08-24](../worklog/squadron-creation-session-2026-08-24.md)
   handoff note; restated on every design artifact since._
   _Why: it lets lanes use existing primitives (see the archive dialog's
   fixed Confirm button) instead of building new ones to match a picture._
5. **Design what is grounded, withdraw what is not.** A surface earns
   design only from the problems doc or an observed need; speculation is
   withdrawn, not deferred.
   _Source: the "asks I'm waiting on" surface, withdrawn on Jackson's
   challenge 2026-08-29 (dogfood UX map);
   [Principle 8](principles.md)._
   _Why: machinery earns its place through observed need; anticipating
   builds the wrong thing._

## How surfaces look

6. **Integrate into existing UI; never invent a surface.** New
   capability lands inside the control the user already uses.
   _Source: the Role dropdown went into the composer (2026-08-23); the
   Squadron chip into the existing sub-bar (2026-08-24); the Squadron
   scope replaced the project dropdown rather than regrouping the
   sidebar ([SB3, 2026-08-29](../worklog/sidebar-roster-session-2026-08-29.md))._
   _Why: users already know where things are; a new surface is a new
   place to look._
7. **The app is hyper-focused on chat; everything else is subtle. Only
   badges shout.** Platform-composed blocks (cards, notices, dialogs)
   take upstream's quiet surface treatment; the small elements that
   demand attention — urgency and reply-state badges — are the only
   colorful things.
   _Source: [TA6, prominence session, 2026-08-31](../worklog/thread-a2a-prominence-session-2026-08-31.md),
   where a tinted card was adopted only after de-tinting._
   _Why: attention is the scarce resource; if everything is prominent,
   nothing is._
8. **Reuse upstream's idioms for disclosure and time.** Long content
   clamps behind the existing chevron pattern ("Worked for 8.3s ›"), and
   elapsed time uses the app's existing formatter, so no two surfaces
   render the same fact differently.
   _Source: [TA7 and TA9](../worklog/thread-a2a-prominence-session-2026-08-31.md);
   the archive dialog reuses the inbox's `open ⟨elapsed⟩` call
   ([AR5](features/archive-flow.md))._
   _Why: a clamp is a UI limitation, never a content limitation — and one
   formatter per fact is how surfaces stay in agreement._
9. **No continuously repainting animation.** Status is a label, not a
   spinner; attention is expressed by de-emphasis of what does not need
   it.
   _Source: inherited from upstream's performance culture and confirmed
   in the sidebar research (2026-08-29)._
   _Why: users drive agents all day and notice a pegged GPU and a lying
   spinner._

## What surfaces say

10. **Never guess — an unknown renders as an unknown.** A missing fact
    shows as `?` or "couldn't check"; a label never asserts a state the
    data does not carry (a chip reads "Reply" only when the role is
    measured as reply; a plain message carries no chip).
    _Source: [Principle 6](principles.md); ruled into surfaces at
    [SB6](../worklog/sidebar-roster-session-2026-08-29.md),
    [AR2](features/archive-flow.md), and the chip-copy clarification of
    2026-08-31 in [`features/thread-a2a-rendering.md`](features/thread-a2a-rendering.md)._
    _Why: a plausible fake spends attention on the wrong thing and costs
    the trust the surface exists to earn._
11. **Users read plain words; agents read mechanics.** User-facing copy
    says "Replied" or "Expects reply"; exchange-closure and protocol
    language stays inside the agent envelopes.
    _Source: Jackson's copy-unification ruling, 2026-09-01 (commit
    "reply cards say Replied, mechanics stay in envelopes";
    [`features/thread-a2a-rendering.md`](features/thread-a2a-rendering.md))._
    _Why: the envelope is written for the agent; the human should read
    the letter, not the postal regulations._
12. **Named concepts are Title Case in documents; UI copy follows
    upstream's measured capitalization.** Squadron, Crew, Role, Peer
    Agent are Title Case in prose (the [glossary](glossary.md)
    convention); labels, menus, and options in the app are capitalized
    the way comparable upstream surfaces are — measured, never assumed
    ("All squadrons" in sentence case, matching upstream's dropdown).
    _Source: glossary writing convention; Jackson's typography ruling,
    2026-09-01 (recorded in the fleet standing rules)._
    _Why: documents teach the vocabulary; the app must feel like one
    product, not a fork with its own house style._
13. **Attribution is truthful and viewer-neutral.** Badges say "Expects
    reply", not "expects your reply"; a human's messages are attributed
    to the person only when the person is known, never assumed to be the
    viewer.
    _Source: TA1 amendment and the DV4 override, 2026-08-31
    ([`features/thread-a2a-rendering.md`](features/thread-a2a-rendering.md),
    [`dogfood-v0.md`](dogfood-v0.md))._
    _Why: nothing may assume exactly one human (R29), and a wrong "you"
    is a lie the reader cannot detect._

## Reusable patterns

14. **The urgency-first row.** Any row that represents an open ask reads:
    urgency badge first (blocking / soon / fyi) → direction glyph and the
    counterpart's display name (lucide Send + "To", lucide Inbox +
    "From"; an unknown name renders as "Unnamed participant", never a
    raw id) → the intent as the subject, clamped → time-since as the
    trailing measured fact.
    _Source: [IB3, inbox](features/inbox.md) (2026-08-29) and
    [AR5, archive dialog](features/archive-flow.md) (2026-09-01,
    Variant B ruled)._
    _Why: two surfaces that show the same fact should rhyme; the user
    learns the row once._
15. **The A2A card family.** Platform-composed messages in a thread
    (received, sent, replies, silence notices, spawn briefs) are
    left-aligned cards in the subtle treatment; only the human's own
    messages sit right. Details in
    [`features/thread-a2a-rendering.md`](features/thread-a2a-rendering.md).
    _Source: [TA6–TA10](../worklog/thread-a2a-prominence-session-2026-08-31.md)._
    _Why: alignment carries authorship; a platform message that looks
    like the human's is a misattribution._
16. **Minimal effort on non-differentiators.** When a capability is not
    what J5 is for (in-app git, a button label that would need a new
    shared seam), build the smallest honest version and move on.
    _Source: [P-F, Roles/Crews session](../worklog/roles-crews-session-2026-08-23.md)
    ("we should spend minimal effort here"); the archive dialog's
    fixed-Confirm ruling, 2026-08-31._
    _Why: effort spent on the undifferentiated is effort not spent on the
    fleet._

## Amending this document

A convention changes when Jackson rules; record the new ruling in the
session worklog first, then update the entry here with the date and
link. Never edit an entry to match an implementation — fix the
implementation or get the ruling.
