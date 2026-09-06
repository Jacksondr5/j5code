# Substrate session — rulings record (2026-08-29)

Jackson + architecture evaluator. Origin: Jackson's zoom-out challenge on the A6/#12 evaluation —
"my concern isn't whether this faithfully implemented the ticket; it's whether this is the thing we
should be building" — widened from "delegate_task vs root lineage" to "which upstream T3 mechanisms
are safe substrate at all." Method: code re-measurement at the frozen A6 head (`31267e832`),
read-only forensics on the retained A6 live-proof databases, and reconciliation against the
spawn-terminology (ST1–ST5) and Squadron-creation (SC1–SC4) rulings of 2026-08-24. Outcome doc of
record: [`product/a2a/substrate.md`](../product/a2a/substrate.md).

## The evidence chain (in the order it corrected us)

1. **The lineage cascade does not kill children.** The session began under the belief (Reviewer
   briefing, echoed by the evaluator) that upstream's `cascadeTerminalizeRunOwnedSubagents` reaps
   delegated children by lineage when the spawner's run dies. Verified false: it emits only
   `subagent.updated`/`node.updated`/`turn-item.updated` projection events terminalizing the
   _parent's tracking rows_; the only child-stopping paths are explicit `cancelTask` / per-thread
   interrupt (which J5's placement cascade dispatches). Delegated children survive their spawner.
   The dual-authority concern reduced from destructive to presentational.

2. **There was never a delivery bug.** The A6 live proof's "failed" attempt — a delivered
   `expect_reply` ask with no reply, read at the time as "delivery does not wake an idle child" —
   was re-examined against the retained databases (`/tmp/j5-a6-live.mWKKbF`,
   `/tmp/j5-a6-final2-live.UuQmUp`, read-only copies). In _both_ attempts the ask was **steered
   into the child's active run** (delivery message rows bound to child run ordinal 1, mid-run
   timestamps; no `queued` or `waiting` run in either database). The failed child's own final
   message acknowledges the envelope and declines to reply — as its briefing instructed. The PASS
   run's "controlled second turn" actually resolved in-turn within run 1. `turn-ended-no-reply`
   correctly classified an instructed silence. Steer-when-busy is live-proven; start-when-idle is
   code-verified (`CommandPolicy.ts` `queue_after_active` → `start_run` when no active run; queued
   runs promoted by the Orchestrator's terminal-run subscription, with startup recovery). One cheap
   live confirmation of the idle branch remains worthwhile.

3. **The "auto-wake" question dissolved into a product gap.** What the failed proof actually
   exposed: a receiver that defers a delivered ask has no "later" — nothing re-surfaces an open
   Exchange to an idle agent. Substrate-independent; memo/inbox territory (R24–R35, principle 6);
   named as a build item.

4. **`delegate_task`'s last mechanical justification fell.** With the cascade corrected (1) and
   transport proven (2), its unique remaining buy — the delegated-completion wake — fills no gap
   Exchanges leave open. ST5's exclusion got its mechanical disposition: non-exposure via a
   J5-owned toolkit subset, not deletion (fork economics).

5. **`t3_thread_send` is transport, not A2A.** The layering law was articulated: A2A =
   `sendToThread` injection + envelope + ledger + Exchange + receipts + silence. Raw thread-send
   between agents is peer communication the graph cannot see — the silent-stall failure mode,
   invisibly caused. This generalized the delegate_task disposition to the whole agent tool
   surface: writes go through J5 verbs; reads stay.

6. **The Codex shadow-thread guard.** The spawn-terminology inventory's finding (Codex-native
   Subagents hold live resumable AppThreads) was verified at the pin
   (`CodexAdapterV2.ts` `registerSubagentThread`, `activeProviderThreadId` set). Consequence:
   participanthood must be registration-based, never thread-existence- or addressability-based.

## Rulings taken

- The four-bucket substrate map (consume / record-only / rebuild / build) — see substrate.md.
- Peer Agent spawn is root-thread creation + Registrar + placement; result obligations ride
  Exchanges; upstream lineage is never consulted for Peer Agents.
- `delegate_task`, `task_status`, `task_cancel`, `t3_thread_send`, `t3_thread_interrupt` come off
  the agent surface via `J5OrchestratorSurface` (J5-owned subset toolkit, fail-closed on rebase).
- The ownership rule: upstream owns existence/lifecycle state; J5 overlays org facts;
  participanthood by explicit registration only, with the provider-creation guard.
- Docs convention applied: this record is historical; `substrate.md` is current truth.

## Left open

`create_threads`/`t3_thread_start` on the agent surface (drop recommended, undecided); the
re-surfacing and orphan-policy build items; the forks/checkpoints session on lineage's non-org
consumers; the Crews solo-spawn question (untouched, per its standing deferral).

## Corrections trail (for the record)

Three beliefs died in one day, each by direct measurement: "the cascade kills children" (killed by
code reading), "delivery can't wake an idle receiver" (killed by database forensics), and "queued
runs have no promoter" (killed by re-grepping a 268 KB file with `grep -a` — it was being
binary-detected and silently returning nothing). The session's working rule held: claims get
re-measured at the exact head before they carry weight.
