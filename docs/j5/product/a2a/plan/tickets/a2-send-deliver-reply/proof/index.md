---
title: "A2 live proof — real Codex to Claude exchange"
kind: spec
---

# A2 live proof — historical pipeline PASS

Recorded 2026-08-17 at reviewed head `e1516b77dcb0e170ce4973523a63c071da07950d`.

## Isolation

- Fresh detached clean checkout with an independent frozen install and production build.
- Fresh disposable T3 home and Git-initialized project under `/tmp`.
- Node 24.14.0 and the repository-supported watch-free production server path.
- Server remained stable for more than 90 seconds before a newly minted pairing credential was consumed once through the authorized Playwright surface.
- The proof process stopped its captured PID and verified the test port closed. No source, PR, board, or shared-state changes were made.

Raw token-bearing pairing output remains only inside the disposable evidence base and is not copied into this artifact.

## Real-provider exchange

| Participant | Provider | Result |
| --- | --- | --- |
| Sender | Codex, GPT-5.6-Sol | Explicitly joined, listed participants, sent one reply-expected A2A ask, then observed the reply. |
| Receiver | Claude Fable 5 | Explicitly joined, received the rendered envelope, replied once carrying the injected exchange id. |

The observed tool sequence was one `join_epic` per participant, sender `list_participants`, one sender `send_message` with `expect_reply=true`, and one receiver `send_message` carrying the exchange id. The sender made no second send.

## Durable evidence

For the isolated proof epic, ledger order was:

1. sender `participant.joined`
2. receiver `participant.joined`
3. `exchange.opened`
4. ask `message.sent`
5. ask `message.delivered`
6. reply `message.sent`
7. `exchange.closed`
8. reply `message.delivered`

The exchange was `closed` with a non-null close sequence. Exactly two delivery rows were `delivered` with `attempts = 1`; alarm count was zero. Exactly two upstream delivered-command receipts and two injected MCP projection messages existed. Both receiving-thread messages contained the rendered A2A envelope and exchange instruction; the UI also showed the receiver's one-reply closure confirmation.

## Boundary

This proof accurately established the pipeline behavior at `e1516b7`, including the then-shipped agent-facing `join_epic` bootstrap. It is **not evidence for the reduced PR #7 shipped path** after E1–E5 removed that tool and all agent membership provisioning. Decision #17 is therefore scoped/superseded for current acceptance, not a current end-to-end PASS.

The named A2 registrar + A6 wrapper-creation follow-up must rerun the real Codex→Claude exchange through its internal creation-time registration path before A3 staffs. Until then, native no-home threads are intentionally not A2A participants; the reduced PR’s CI and review evidence cover the pipeline and wording only.
