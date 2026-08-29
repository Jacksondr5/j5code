# Upstream research: "settled" vs "archived" (2026-08-29)

Commissioned by Jackson; code inventory of the upstream orchestration-v2 pin with file:line evidence (full detail in the research transcript; this records the essence + J5 implications). Directly relevant to A9 (lifecycle-closure), the Crews archive machinery (R1/R2/R19), and the glossary.

## Upstream has three senses of "settled" — only one is a state

1. **Thread-level Settled (the real concept): inbox triage on a live thread.** A persisted, reversible flag (`settledOverride`/`settledAt`, sibling to snooze/pin) meaning "I'm done looking at this." Guards: cannot settle with pending approvals, pending user input, a live session, or a queued turn start — it can never hide active or blocked-on-you work; the server rejects, the client mirrors. Auto-settle: on merged PR (configurable), always on closed PR, or after N days of inactivity (an open PR blocks inactivity auto-settle). Any message dispatch silently un-settles (overrides never go stale); pinning un-settles; settling clears pin ("settling is 'I'm done with this'"). One hard side effect: detaches the (necessarily idle) provider session so background work doesn't run on a "done" thread — but does NOT revoke MCP credentials. UI: a separate "Settled" sidebar partition; the thread stays in the live shell stream.
2. **Run/turn "settlement" (code slang):** "the turn settles" = the root run hit a terminal status (`completed|interrupted|failed|cancelled`). Not stored; named survivors deliberately outlive it (background subagent registry, wake evidence, checkpoint capture, delegated-completion delivery with `completionWake: settled_only`).
3. **Outbox "settlement" (promise slang):** `cancelUnsettled` on effect rows. Unrelated; don't conflate.

## "Archived": reversible eviction with real teardown

User-only action; a nullable `archivedAt` on the thread row. At archive time the server: cancels **queued** runs (not running ones — see gotcha), detaches ALL provider sessions **with MCP credential revocation** (the terminal boundary — archive/delete are the only credential-revoking detaches), kills the thread's terminals, and disposes delegated-completion deliveries. **Deletes nothing** (delete is a separate soft-delete), **worktree untouched** (worktree removal is a delete-time client offer only). While archived: cannot receive messages (hard error), cannot be settled/snoozed/pinned, skipped by queued-run startup, wake requests dropped. Evicted from the sidebar AND the live shell snapshot into a dedicated archive feed (Settings → Archived Threads; unarchive + delete are the only actions — no opening the conversation). Unarchive restores the flag only; sessions/credentials/terminals are gone and re-establish on next engagement.

## Gotchas that matter

- **"Cannot archive a running thread" is a CLIENT guard only.** The server allows it and force-tears-down (interrupts active turns via detach). Any non-UI caller bypasses the guard. Upstream never made it a server invariant.
- **No cascade**: archiving a parent does not archive delegated children; their completions are silently disposed (never delivered).
- **Scheduled tasks bound to an archived thread are not stopped** — each fire fails with the archived error and records a failed run.
- No user-facing docs exist for either concept; semantics live in code comments.

## J5 implications (for A9 and the Crews archive design)

1. **Our archive-is-loud (R1/R2) is additive on a solid substrate**: upstream gives the flag, teardown cascade, and credential boundary; the ledger notices to Exchange waiters are purely our layer. A send to an archived participant should surface as a ledger delivery failure (visible gap) rather than upstream's bare error — our pipeline already models this.
2. **The Crews warn-and-confirm on archive-with-open-Exchanges should be SERVER behavior.** Upstream's precedent (client-only guard + silent server force-teardown) is exactly the shape our own rulings reject; the archive command in J5's surface should carry the open-Exchange count/list and require confirmation server-side. Same for R19's Captain-invoked archive (a non-UI caller — precisely who bypasses upstream's client guard today).
3. **Upstream Settled is prg's retirement ceremony, discovered in the wild** — auto-settle on merged PR is literally the PR-Group retirement trigger, and the can't-settle-with-pending-obligations guard rhymes with our archive warning. Adopt-over-redefine: keep upstream's Settled as-is; one alignment item for A9 — the settle guard knows approvals/user-input but not our ledger; whether open Exchanges should also block (or warn on) settle is a J5 decision to make deliberately.
4. **Terminology note for the glossary/docs**: "settled" now has an upstream user-facing meaning (thread triage) distinct from our editorial "settled ruling" usage; and run-level "settle" is code slang for went-terminal. Writers beware.
