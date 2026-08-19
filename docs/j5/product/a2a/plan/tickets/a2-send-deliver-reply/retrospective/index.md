---
title: "A2 retrospective — live provider proof isolation"
kind: spec
---

# Live provider proof isolation

Recorded 2026-08-17 after an A2 proof attempt was cancelled by a watched dev-server restart while the shared Builder worktree changed.

## Rule

Every live provider proof must run from a **fresh detached worktree at the exact reviewed head**, with its own dependencies. It must never use a live group worktree.

Mutable state, disposable project data, and logs live outside watched trees. Before pairing or starting provider turns, require a 90-second no-restart gate.

## Why

A cancelled provider turn is not evidence of feature failure or success. Separating the proof checkout from active implementation preserves exact-head provenance and prevents file-watch restarts from invalidating a once-only protocol.

## A2 application

The final authorized A2 Codex-to-Claude proof is detached at `e1516b77dcb0e170ce4973523a63c071da07950d`; Builder #28 changes remain held in the shared group worktree until the isolated proof returns.

## PR #7 closeout

- Exact-head mutation checks and independent review caught real delivery, replay, concurrency, wording, and authorization-boundary defects before merge. Keep the initial internal dedup gate and discriminating mutations early in future slices.
- When product membership semantics are not ratified, remove the speculative surface rather than ship an agent-invocable workaround. PR #7 correctly became a fail-closed pipeline; registrar + A6 creation integration own conferred membership and the replacement live proof.
- The formal group-level merge delegation was not enough to override the role rule. Escalating for the named Builder executor was a positive control; future exceptions must record both scope and executing role before a merge gate opens.
- The one-off merge exception closed with squash merge `6e577f15120f4a7fbc714957b70d590f02cf86b4` on 2026-08-19. GitHub attributes the merge to `Jacksondr5`; the Builder reported executing the authorized CLI command. Future exceptions still require explicit scope and named executor before action, and Jackson-merges default resumes for every later PR.

## Reviewer closeout lessons

- Negative repository searches must use text mode here: ugrep can classify `Orchestrator.ts` and `ProviderSessionManager.ts` as binary, hiding the production command-dedup implementation. Use `rg -a` or `--binary-files=text` before treating a zero-result search as evidence.
- For a guarantee that crosses layers, require at least one test that crosses the seam. Separate green tests for each half of exactly-once delivery did not prove projection lookup, project resolution, dispatch mode, and upstream injection together; the real-layer test added for finding #28 did.
- Mutation tests are required evidence for claimed invariants, not polish. The bootstrap command-id control initially remained green under a random suffix because a different sequential read was enforcing observed idempotency.
- A scope cut requires re-auditing closed findings and PASS evidence. The historical live proof relied on removed `join_epic`; it was correctly re-scoped rather than left falsely green for the reduced PR.
- Protected-file inventories should anchor to an enclosing symbol and commit SHA, with line numbers expressly snapshot-relative. A line-keyed anchor shifted immediately after the first allowed deletion.
- Human review comments anchored to one instance may state a broader class rule. Audit the entire agent-facing surface, not only the quoted line.
- `git checkout <sha> -- <path>` mutates the index. After any before/after verification, restore with `git checkout HEAD -- <path>` and prove `git diff HEAD` is empty before returning the baton.
