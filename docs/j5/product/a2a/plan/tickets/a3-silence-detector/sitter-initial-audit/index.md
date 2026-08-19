---
kind: spec
title: "A3 sitter initial audit"
---

# A3 sitter initial audit

Audited 2026-08-19 on `j5/a3-silence-detector` at `fdd04688c7bbb781496003db8e3868cadc00e20d` (`origin/j5/main`, clean worktree).

| Check | Result |
| --- | --- |
| A2 boundary | Existing `formatSilenceNoticeEnvelope` and `silence.notice` ledger kind are present. A3 consumes that channel; it does not change its rendering or delivery pipeline. |
| Terminology | The live A2 surface uses `Squadron`; remaining `epic` identifiers are migration history only. A3 additions must use Squadron terminology. |
| Fork boundary | `FORK.md` permits new J5-owned files and only the enumerated upstream integration cases. No A3 exception is authorized. |
| Fixtures | Direct membership seeding is allowed only in tests; production membership provisioning remains out of scope. |

## Acceptance hold

**Held final end-to-end acceptance:** A3 may build and run focused tests now, but may not claim final E2E acceptance until the home-Squadron registrar and A6 wrapper lifecycle integration are re-proven. The outstanding integration must supply real run-lifecycle facts and production membership provisioning; A3 must not invent either seam. The group will coordinate the narrow interface with the A6 Sitter before integrating.

## Review requirement

The independent Reviewer must perform a terminology-residue check across the A3 diff and reject newly introduced legacy `epic` wording outside necessary historical migration compatibility.

## X1 — Squadron-local authority

Settled by the Spawner on 2026-08-19: a Squadron permanently resides on one server. Authority never replicates; multi-server Squadron residency is a non-goal. A3 silence detection is therefore Squadron-local. Future D8 messages may cross servers through a double-entry seam, while read models merge client-side. This does not change A3 scope and authorizes no replication or multi-server hedge.

## Decision — existing J5-owned A2 evolution

The existing A2 transport always renders agent delivery as peer or human traffic. Its persisted `message.sent` payload and delivery projection carry no envelope-channel value, despite the existing A2 `formatSilenceNoticeEnvelope` channel. A3 must not create a parallel injector or peer-wrap a silence notice.

**Approved by the Spawner on 2026-08-19.** These are ordinary J5-owned contract/runtime evolution, not an enumerated upstream append exception; coordinate because they are shared across lanes. A3 may add typed persisted `peer | silence_notice` propagation through the existing A2 delivery path and compose its detector layer in the existing J5 runtime layer. Legacy rows and ordinary sends explicitly default to `peer`; the change must document that backfill behavior. The Reviewer must require an exhaustive, fail-closed channel match and a negative control proving a silence notice can never be peer-wrapped. No upstream-owned file exception is authorized.
