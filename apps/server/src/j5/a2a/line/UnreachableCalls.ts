import type { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import {
  CommCommandId,
  CorrelationId,
  LIFECYCLE_PARTICIPANT_ID,
  LedgerMessageId,
  LedgerProjectId,
  ParticipantId,
} from "../contracts.ts";
import { A2ADeliveryWorker } from "../DeliveryWorker.ts";
import { formatBackInReachNotice } from "../deliveryNotices.ts";
import { A2ALedgerTransactionWriter } from "../LedgerService.ts";
import { PeerRegistryService } from "../PeerRegistryService.ts";
import { LineRegistry } from "./LineRegistry.ts";
import { UnreachableCalls, type UnreachableCallsShape } from "./UnreachableCallsService.ts";

interface FailedCall {
  readonly threadId: ThreadId;
  readonly tool: string;
  readonly at: string;
  /** The line that was up when the call started, if any; its own line coming back is not news. */
  readonly lineId: string | null;
}

const isUnanswered = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "OrchestratorMcpFailure" &&
  "code" in error &&
  error.code === "peer_unreachable";

const make = Effect.gen(function* () {
  const lines = yield* LineRegistry;
  const peers = yield* PeerRegistryService;
  const sql = yield* SqlClient.SqlClient;
  const writer = yield* A2ALedgerTransactionWriter;
  const worker = yield* A2ADeliveryWorker;
  const pending = new Map<string, Array<FailedCall>>();
  // Recording and notifying take turns, so a line coming up never misses a call being recorded.
  const turn = yield* Semaphore.make(1);

  /** One notice per thread, in the thread's project; a thread archived or not a participant gets none. */
  const notify = Effect.fn("j5.a2a.line.notifyBackInReach")(function* (
    environmentId: string,
    lineId: string,
    calls: ReadonlyArray<FailedCall>,
  ) {
    const peer = yield* peers.get(environmentId);
    if (peer === null) return;
    const byThread = new Map<ThreadId, Array<FailedCall>>();
    for (const call of calls) {
      byThread.set(call.threadId, [...(byThread.get(call.threadId) ?? []), call]);
    }
    for (const [threadId, threadCalls] of byThread) {
      const membership = (yield* sql<{
        readonly project_id: string;
        readonly participant_id: string;
      }>`
        SELECT project_id, participant_id FROM j5_a2a_membership
        WHERE thread_id = ${threadId} AND participant_kind = 'agent' AND archived_at IS NULL
        LIMIT 1
      `)[0];
      if (membership === undefined) continue;
      const key = `${encodeURIComponent(lineId)}:${encodeURIComponent(threadId)}:${encodeURIComponent(threadCalls[0]!.at)}`;
      const commandId = CommCommandId.make(`j5-back-in-reach:${key}`);
      const projectId = LedgerProjectId.make(membership.project_id);
      const at = DateTime.formatIso(yield* DateTime.now);
      const outcome = yield* writer.withPermit(
        sql.withTransaction(
          writer.appendEventsInTransaction({
            commandId,
            projectId,
            acceptedAt: at,
            events: [
              {
                kind: "message.sent",
                sender: LIFECYCLE_PARTICIPANT_ID,
                receiver: ParticipantId.make(membership.participant_id),
                exchangeId: null,
                correlationId: CorrelationId.make(`correlation:j5:a2a:back-in-reach:${key}`),
                payload: {
                  messageId: LedgerMessageId.make(`message:j5:a2a:back-in-reach:${key}`),
                  text: formatBackInReachNotice({ serverName: peer.label, calls: threadCalls }),
                  originProjectId: projectId,
                  receiverProjectId: projectId,
                  exchangeRole: "none",
                  envelopeChannel: "lifecycle_notice",
                },
                createdAt: at,
              },
            ],
          }),
        ),
      );
      if (!outcome.committed) continue;
      yield* writer.publishCommitted(outcome.events);
      // The ledger PubSub does not wake the delivery worker; every producer that commits wakes it.
      yield* worker.notify;
    }
  });

  const record = Effect.fn("j5.a2a.line.recordUnanswered")(function* (
    environmentId: string,
    call: FailedCall,
  ) {
    const peer = yield* peers.get(environmentId);
    if (peer?.linkMode !== "store") return;
    const current = lines.currentLineId(environmentId);
    // Its line already came back since the call started: nothing to wait for.
    if (current !== null && current !== call.lineId) {
      yield* notify(environmentId, current, [call]);
      return;
    }
    pending.set(environmentId, [...(pending.get(environmentId) ?? []), call]);
  });

  const observe: UnreachableCallsShape["observe"] = (input, call) => {
    const threadId = input.threadId;
    if (threadId === undefined) return call;
    return Effect.suspend(() => {
      const lineId = lines.currentLineId(input.environmentId);
      return call.pipe(
        Effect.tapError((error) =>
          isUnanswered(error)
            ? DateTime.now.pipe(
                Effect.flatMap((now) =>
                  turn.withPermit(
                    record(input.environmentId, {
                      threadId,
                      tool: input.tool,
                      at: DateTime.formatIso(now),
                      lineId,
                    }),
                  ),
                ),
                Effect.catchCause((cause) =>
                  Effect.logWarning("J5 unanswered call could not be noted", { cause }),
                ),
              )
            : Effect.void,
        ),
      );
    });
  };

  const scope = yield* Effect.scope;
  const ups = yield* lines.subscribeUps;
  yield* ups.pipe(
    Stream.runForEach((up) =>
      turn.withPermit(
        Effect.gen(function* () {
          const waiting = pending.get(up.environmentId) ?? [];
          pending.set(
            up.environmentId,
            waiting.filter((call) => call.lineId === up.lineId),
          );
          // Calls from before the peer was last recorded belong to an earlier peering, which ended.
          const peer = yield* peers.get(up.environmentId);
          const due = waiting.filter(
            (call) => call.lineId !== up.lineId && peer !== null && call.at >= peer.createdAt,
          );
          if (due.length === 0) return;
          yield* notify(up.environmentId, up.lineId, due);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("J5 back-in-reach notices could not be sent", { cause }),
          ),
        ),
      ),
    ),
    Effect.forkIn(scope),
  );
  return UnreachableCalls.of({ observe });
});

export const layer = Layer.effect(UnreachableCalls, make);
