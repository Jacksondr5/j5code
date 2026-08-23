---
title: "Beliefs, lenses, and principles - the machine that turns problems and goals into product"
kind: spec
---

This document covers the beliefs, lenses, and principles used to design and architect features for J5 Code. Taken together, these 3 things form the machine that transforms the [problems and goals](./problems.md) into [features](features/). Never restate the problems and goals here.

# Beliefs

The falsifiable claims the product stands on.

1. AI's weaknesses are inherent. They can only be helped, not solved. No amount of machinery turns an agent into something that never fails. We have to understand what the limits and failure modes are, and not push the agents beyond them. These weaknesses are stated in [the problems doc](./problems.md).
2. Helping is still enormously valuable. The gap between an unaided agent and a well-supported one is most of this product's value. We don't need perfection to be transformative. Many of our goals are aiming to do just this.
3. Trying to fully solve creates fragile systems. Machinery that promises to eliminate an inherent weakness in LLMs costs more than it returns and breaks in ways that are worse than the weakness — the effort belongs in helping, not solving.
4. The user's attention is the limiting factor on how much they can build. Fleet output is bounded by human attention, not by agent capacity. Every unit of attention the platform recovers multiplies what the user can build.
5. We are at the frontier of agentic work; we will be wrong. Nobody knows how fleets behave at scale. Designs are provisional, intuitions are suspect, and being wrong is the expected case to plan for — not the exception.

# Lenses

Lenses are tools that we use to refine our designs. They provide stress tests and different ways to think about the feature.

## 1. The human-contact spectrum

In a fleet, all agents sit somewhere on the spectrum. This spectrum is measured by how frequently an agent communicates with the user directly through the chat interface.

On one side, a Foreground agent chats with the human through the chat interface very frequently. On the other, a Background agent reaches the human only through the inbox or its Captain (which is likely a Foreground agent). Agents can sit in the middle as well.

When designing features, thinking of where an agent lives on this spectrum can reveal important things about the feature.

Foreground agents tend to be longer-living than Background agents, so it's important to keep their context clean and focused on what the user is talking about. The user is also reading their chats, so having that constantly interrupted by A2A messages harms the user's focus.

Background agents are almost never seen by the user, so they need a way to send important blocker/notes to the user. They also shouldn't take away from the user's focus by cluttering up the UI more than needed. The user cares more about their status than their thoughts.

This lens classifies which surface serves whom, sets communication norms, and predicts where an agent's value lives: Background agents' value is in their definitions and durable artifacts (making them cheap to respawn); Foreground agents accumulate irreplaceable conversational context.

## 2. Mechanical vs. judgment

Split any "agents don't notice / don't do X" problem into two halves: the mechanical half (a measurable fact nobody delivered — the platform can fix this) and the judgment half (a call that can't be reliably decided by code — route it to a mind, agent or human, carrying the facts).

Many of the things we're trying to build can be analyzed by splitting the situation into mechanical and judgement parts. Looking at them through this lens helps you decide what the platform can solve and what agents need to solve.

Mechanics are things that an imperatively coded platform can do. They require measurable facts with low ambiguity. For example, the platform can determine that an agent's turn ended without replying to an open message, or that an agent died mid-task, or that a certain amount of time has passed. These are simple facts that require little to no interpretation, meaning code can easily act on them.

Judgments require interpretation. Did the agent that ended without replying forget to reply, or is it waiting on something before replying? When the reply arrives, did it answer the question properly? Is the crew that completed an hour ago stalled or done? Code cannot answer these questions reliably, it needs an agent or the user. Be careful, edge cases can turn mechanics into judgments.

Getting the balance right is key. If we have the platform act on something that requires judgment, it can send the agents down the wrong path and compound the issue. If we require judgment for something measurable, we introduce LLM variability into the equation and waste time and money.

Each part lends itself to different solution. We can solve a mechanical problem by applying the right kind of automation in the platform. Injecting time into the agent's context so it doesn't need to burn tokens measuring it, for example. Judgment problems are often best solved by increasing visibility. When an agent dies, elevate that to the user's dashboard so they notice it faster and can take the right action. Notify the Captain that a member of its Crew has fallen over.

A feature can have parts that are mechanical and parts that are judgment. What counts as mechanics and judgment can change over time as the product and AI capabilities evolve.

## 3. Use cases

J5 Code has multiple use cases, defined in [use-cases.md](use-cases.md). These are concrete use cases that the product is aiming to serve. Run your features through them to see how they serve those use cases.

---

# Product principles

The principles in this document are what guide us when designing, architecting, and building J5 Code. They frame our thinking when we come up with features. Most importantly, they help us decide what to build and what NOT to build.

Each principle states its rule, what it stands on (beliefs and lenses above), its jurisdiction — the kind of question it decides — and the cases it has already decided. R-numbers point into the [design-review register](./design-review-2026-08-21.md). A principle you cannot cite to kill or reshape a proposal is not pulling its weight.

## 1. The hierarchy carries decisions, never messages

**Rule:** any agent may message any agent directly; the org tree exists for tie-breaks, priorities, and resource calls — never as a communication path.

**Stands on:** the fleet's organizational theory (scoped rationale, not a universal belief): routing conversation through managers is a game of telephone — peers coordinate best directly, while higher-ups are the right tie-breakers and high-level decision makers. Mirrors healthy human organizations.

**Jurisdiction:** communication topology and command structure — who may talk to whom, who spawns and briefs whom.

**Cases:** any-to-any messaging is a platform invariant and Captains are never routers (R22); "you command what you brief" — placement = spawner, and spawning-and-briefing a Crew for someone else is proxy management (R21); lateral-coordination norms are Role content, never permission checks.

## 2. Prompting problems are not platform problems

**Rule:** behavior is fixed by Role definitions, prompting, and right-sized work; platform machinery only ever fixes mechanics.

**Stands on:** beliefs 1 and 3; the mechanical-vs-judgment lens.

**Jurisdiction:** where a solution lives. When a design wants the platform to enforce a behavior, this is the objection to answer first.

**Cases:** reply completeness is judged by the sender, taught by envelope text, never checked by code (R3); communication-routing norms and human-contact posture live in Role definitions (R23); group cohesion, verbosity, and register are content, not tooling.

## 3. Build tools that make agents better, never systems that make them perfect

**Rule:** raise the odds of good behavior, surface the misses, cheapen the recovery — never attempt to guarantee what an agent will do.

**Stands on:** beliefs 1 and 2 — the weaknesses are inherent, and helping is where the value lives.

**Jurisdiction:** a tool's ambition — what any feature is allowed to promise.

**Cases:** Memos are a tool plus visibility (badges, archive warnings, the backlog pane), not forced context injection (R31); Exchange semantics are envelope-taught, not schema-coerced; recovery is cheap by design — respawn a Crew from its definition (R14), reopen an Exchange with `regarding` (R10), nudge from a pane.

## 4. The platform delivers facts, never judgment

**Rule:** measurements ship as features in J5 Code; verdicts route to an agent or human, carrying the facts.

**Stands on:** belief 1 and the mechanical-vs-judgment lens; a wrong conclusion delivered authoritatively is strictly worse than a fact delivered plainly.

**Jurisdiction:** what the platform may output or automate. Anything phrased as "the platform detects…" gets tested here: is that a measurement or a verdict?

**Cases:** silence notices inform and never auto-close Exchanges; notices carry fact bundles while labels are projection policy (R4); Playbook advancement is agent-declared, never platform-judged (R27); "Crew done" vs "Crew waiting" is structurally the Captain's or human's call, not a gap to engineer away.

## 5. Status is read, never asked

**Rule:** if the user must ask an agent for a fact, the platform is missing a surface.

**Stands on:** belief 4 — and asking doesn't even work: agents answer from context, not measurement ([context as bad memory](./problems.md)).

**Jurisdiction:** what the human must do to learn the fleet's state.

**Cases:** the observability dashboard and PR pane exist so "how's it going" is a read; cost rolls up per Squadron on a surface (R7); chattiness is a measured metric, not a vibe (R23).

## 6. Never guess — a plausible fake is worse than a visible gap

**Rule:** unknowns render as unknowns, degraded data wears a staleness clock, and nothing may ever look green because data was missing.

**Stands on:** belief 4 — a fake spends the user's attention on the wrong thing and costs the trust that surfaces exist to earn.

**Jurisdiction:** how unknowns, staleness, and degraded measurement render, on every surface.

**Cases:** `mergeable: UNKNOWN` renders as "?", never as mergeable; a broken poller goes quiet with a staleness clock, never loud-wrong; PR↔agent association is conservative — ambiguity shows unassociated rather than guessed (PR pane v1).

## 7. State changes are loud; nothing vanishes silently

**Rule:** every lifecycle transition and failure leaves a visible, evented trace, delivered to whoever it affects.

**Stands on:** belief 4 — silent loss is the most expensive spend of attention, because the user pays it later, with interest, at discovery time.

**Jurisdiction:** lifecycle transitions, terminations, and failures.

**Cases:** archiving a participant or Squadron terminates its obligations with notices to every waiter (R1, R2); an undelivered message is a visible alarm, never a silent loss (A2A M2); membership changes are lifecycle events; archiving an agent with open Memos warns first (R31).

## 8. Simple tools at the frontier

**Rule:** build the smallest thing that solves the observed problem; machinery earns its place through observed need, don't anticipate something we haven't seen.

**Stands on:** beliefs 3 and 5.

**Jurisdiction:** how much to build.

**Cases:** `regarding` shipped because it is one nullable field (R10); Memos are a shaped store, not a generic agent DB (R34); Playbooks ship linear before any DAG (R27); Crews archive as units instead of growing seat-replacement machinery (R14); agent cron/DB primitives wait for a named trigger (R30).

## Scoped principles

Principles with narrower jurisdiction live with their stories, not here. Currently one: **authority never replicates — messages cross, read-models merge**, which governs all distributed-state design and lives in [the cross-device position paper](./cross-device.md).
