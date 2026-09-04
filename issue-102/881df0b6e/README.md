# Issue 102: draft subscription hides the first conversation

Code: `881df0b6e3c7f98e7c90b27cde62c7ba587a8877`; base: `6cffd009f9f803a54bcc143fb07eaf285da9c46a`.

Isolated dev environment: worktree `issue-102`, its own `.j5code` home, web port 8697, server port 16737. No live-server mutation. Both cases use Codex GPT-5.6-Terra and a prompt forbidding tools/file changes.

## Before

Temporarily remove only the new conditional argument, reproducing the original steering subscription behavior. Open a draft, send the first prompt, and remain on the same page. Run 1 completed at 2026-09-04T21:45:17.184Z and `ISSUE102_OK` persisted. The page still says “Send a message to start the conversation.” `before.png` and `before-dom.txt` capture this. The original live affected thread loaded successfully on a fresh tab, consistent with this retained client-state failure.

## After

Restore the conditional, open a new draft, send the equivalent prompt, and remain on that page without reloading. The user message and `ISSUE102_FIXED` render. `after.png` was captured after the final code commit; `persisted-facts.json` records both completed runs. Reloading the previously poisoned thread also restores its transcript; this fix prevents poisoning on future drafts, it does not revive already parked subscriptions in an old loaded client.

## Cause

`ChatComposer.tsx:708` previously passed a draft's reserved ID into `useJ5SteerState`, bypassing `ChatView.tsx:1287`'s existing draft guard. The hook creates a projection subscription. The structured missing result sets shared thread state to deleted (`packages/client-runtime/src/state/threads.ts:620`) and parks it forever (`:569`). Creation later cannot revive it while that state is retained. Guard on the already-reactive server shell's existence at the composer boundary; keep definitive deletion semantics intact.

## Validation and scope

31 focused tests pass (composer, queue, entity guard, thread sync). Actual composer-hook regression fails when the conditional is removed, with expected null versus reserved draft ID. Web typecheck exits 0. Targeted lint exits 0 with a pre-existing unused `formatProviderDisplayName` import warning. Web and desktop share this composer; mobile does not call this J5 hook. The guard is provider independent and preserves environment scoping. Existing server-thread and queue reads remain enabled. No contract, transport, server, migration, or new user-facing action changes.

Browser control intermittently timed out; screenshots and the observed before/after transitions succeeded. No network trace is claimed: console capture did not retain the initial 404. The exact failure is reproduced by the baseline UI and pinned by the existing missing-thread state-machine test plus the new actual composer-call regression.
