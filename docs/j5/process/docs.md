---
title: "How the J5 docs are organized"
kind: process
---

# How the J5 docs are organized

Every document under `docs/j5/` is one of five kinds. The kind decides where the file lives, what its frontmatter says, and — most importantly — whether anything may cite it as the truth about the product.

| Kind           | Directory   | Answers the question                                       | Expected lifetime                                                              | May be cited as current truth? |
| -------------- | ----------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------ |
| **definition** | `product/`  | What is the product, today, at end state?                  | Evergreen — kept true as long as the product exists                            | Yes — the only kind that may   |
| **plan**       | `plans/`    | What are we building next, in what order, with what scope? | Until executed; afterwards a historical "what did we do there?" artifact       | Only for scope and sequence    |
| **research**   | `research/` | What did we learn by studying something, as of a date?     | Decays — with time, and with large changes to the product or the thing studied | No — cite the definition       |
| **record**     | `worklog/`  | What happened, and how did a decision get made?            | Permanently accurate about its date; never about now                           | No — cite the definition       |
| **runbook**    | `runbooks/` | How do I operate the software?                             | While the software it describes runs; re-verified when the software changes    | For operations only            |

`process/` (this directory) holds the rules for working in the repository and is cited for those rules only; a process rule is valid until it is changed.

## Lifetime is the point

The kinds differ most in how long they stay true. A **definition** is the only kind that is maintained to stay true — that is what makes it citable. A **plan** is true while it is being executed and then becomes history: nobody maintains a finished plan, so nothing may depend on one. **Research** is accurate as of its `as_of` and decays from there — with the passage of time and with large changes to the product record or to the thing studied; a reader checks the date before trusting it. A **record** is always accurate about the day it describes and never about today, which is why it cannot be a source of truth even though it is never wrong. When you are unsure which kind a document is, ask how long it is expected to stay valid.

## Definitions

A definition says what the product is. It is written in the present tense, as if the feature exists at its end state, and it is **rewritten, never appended**: when the product changes, the sentence that was true changes, and the History section gains one line saying when and why. Narrative of who proposed what, PR numbers, and build status never appear in the body.

Every feature definition has the same sections, in this order:

1. **Problem** — one paragraph linking the problem or goal in `problems.md` it serves.
2. **Definition** — what it is, and what it is not.
3. **Acceptance criteria** — a numbered list. Each criterion is one testable sentence about observable behavior. These are the only numbered items in the docs, and the only things that get referenced by number (see IDs below).
4. **Scenarios** — concrete situations written as user stories or worked examples, each naming the criteria it exercises.
5. **Scope** — what the current build includes and what waits, by criterion number, linking the plan that sequences it. Scope cuts are stated here and in the plan, nowhere else.
6. **History** — one line per amendment: date, what changed, and a link to the record.

Core definitions (`principles.md`, `problems.md`, `glossary.md`, `use-cases.md`, `fleet-vision.md`, `cross-device.md`) keep their own shapes but follow the same rule: rewritten, never appended; cited by name.

**Who edits definitions.** Anyone may propose a change — in a record, an issue, or a PR — but a definition is changed only through a reviewed docs PR that Product has checked against the other definitions and the principles. This is what keeps definitions from contradicting each other: a decision written down in a session is a proposal until the definition carries it.

## Identifiers

There are two kinds of identifier, and both carry the name of the thing they belong to, so a human can read them without a lookup table:

- **An acceptance criterion, numbered within its feature** — written as the feature name plus the number: "Fleet page AC3", "Squadron AC1". It always links to the criterion. Numbers are never reused within a feature; a retired criterion keeps its number and is marked retired in History.
- **A milestone, numbered within its plan** — written as the plan or feature name plus the number: "Fleet observability M1", "Crews M2". It always links to the milestone in its plan. A milestone's lifetime is the plan's: once executed, the identifier is history and nothing current may depend on it.

Nothing else is numbered:

- **Principles and lenses are cited by name** ("never guess", "the human-contact spectrum"), never by position — positions have changed and will change again.
- **Glossary terms are cited by name**, in Title Case for named product concepts (Squadron, Crew, Captain, Role, Playbook, Memo, Exchange, Peer Agent, Subagent, Spawning Guide, Fleet page) and lowercase for descriptive words (fleet, agent, participant, inbox, ledger, dashboard).
- **Work items are GitHub issues** ("#28") and nothing else. No document assigns a letter-number to a piece of work.
- **Plans sequence work by milestone** ("Fleet observability M1"), and each milestone links the GitHub issues that carry it.

The letter registers used before 2026-09-05 (D, E, X, R, SC, ST, SB, IB, TA, AR, SP, QS, FV, DV, M, P, J, and the A/B/DQ/SQ ticket series) are retired. Records that use them are left as written; each definition that absorbed a register says so in its History line ("former E1–E7 and SC1–SC4 → AC1–AC11") so an old reference can still be followed.

## Plans

A plan sequences work. It names milestones ("Fleet observability M1", "Crews M2"), links the GitHub issues that carry each one, states scope cuts by feature and criterion, and carries `status: active | done` in its frontmatter. A plan never restates acceptance criteria and never defines anything; when a plan and a definition disagree, the definition wins and the plan is wrong.

## Research

A research document reports what was learned from studying code, a product, or a practice. Its frontmatter carries `as_of:` (a commit or a date) and every claim is a claim about that moment. Research is never cited as the truth about our product; if a finding changed the product, the definition changed and its History links the research.

## Records

A record says what happened: a design session, a review, a retrospective, a priority input, a friction list. Filenames are date-first — `2026-09-04-fleet-visibility-session.md` — so the directory sorts as a timeline. A record is never edited after the fact except to add a pointer to the definition that now holds its outcome. A record never defines anything current: if it contains a decision, the decision's home is the definition it links, and the record is the story of how it got there.

## Runbooks

A runbook tells an operator how to run the software. It may cite definitions for behavior and process docs for repository rules.

## Frontmatter

```yaml
---
title: "…"
kind: definition | plan | research | record | runbook | process
as_of: 2026-09-05 # research only: the commit or date the study describes
status: active | done # plans only
---
```

## One test per kind

- Is this true of the product at end state? → definition.
- Does this sequence or scope work? → plan.
- Is this what we learned from studying something else, as of a date? → research.
- Did this happen on a date? → record.
- Does this tell an operator what to do? → runbook.
