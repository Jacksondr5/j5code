import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
  CommCommandId,
  CorrelationId,
  ExchangeId,
  LedgerMessageId,
  ParticipantId,
  SquadronId,
} from "./contracts.ts";
import {
  canBeNotified,
  type DroppedExchange,
  formatPeerDropNotice,
  notDeliveredNoticeEvent,
  notDeliveredNoticeMessageId,
  peerDropEvents,
} from "./deliveryNotices.ts";
import { A2ADeliveryWorker } from "./DeliveryWorker.ts";
import { A2ALedger, type A2ALedgerError } from "./LedgerService.ts";
import { findPeerCounterparty } from "./peerCounterparty.ts";
import { PeerRegistryService, type PeerSessionReadError } from "./PeerRegistryService.ts";

/**
 * Removing a peer wipes the slate on this server, in every link mode. Every
 * open Exchange with a participant on the peer is dropped, with the drop
 * notice to the party here; every message still waiting to reach the peer,
 * stored, retrying, alarmed or handed out, is cancelled, and its sender gets a
 * not-delivered notice unless its Exchange's drop already told it. Then the
 * peer's record goes. Peering again starts empty. Each step is idempotent, so
 * a removal that failed partway is finished by running it again.
 */

export interface PeerRemovalResult {
  readonly removed: boolean;
  readonly cancelledMessages: number;
  readonly droppedExchanges: number;
}

export interface PeerRemovalServiceShape {
  readonly remove: (
    environmentId: string,
  ) => Effect.Effect<PeerRemovalResult, SqlError | A2ALedgerError | PeerSessionReadError>;
}

export class PeerRemovalService extends Context.Service<
  PeerRemovalService,
  PeerRemovalServiceShape
>()("t3/j5/a2a/PeerRemovalService") {}

interface WaitingRow {
  readonly squadron_id: string;
  readonly message_id: string;
  readonly sender_id: string;
  readonly receiver_id: string;
  readonly exchange_id: string | null;
  readonly exchange_role: string;
  readonly correlation_id: string;
}

const stablePart = (value: string) => encodeURIComponent(value);

export const layer: Layer.Layer<
  PeerRemovalService,
  never,
  PeerRegistryService | A2ALedger | A2ADeliveryWorker | SqlClient.SqlClient
> = Layer.effect(
  PeerRemovalService,
  Effect.gen(function* () {
    const peers = yield* PeerRegistryService;
    const ledger = yield* A2ALedger;
    const worker = yield* A2ADeliveryWorker;
    const sql = yield* SqlClient.SqlClient;

    const remove: PeerRemovalServiceShape["remove"] = (environmentId) =>
      Effect.gen(function* () {
        const serverName = (yield* peers.get(environmentId))?.label ?? environmentId;
        const because = `${serverName} is no longer peered`;
        const now = DateTime.formatIso(yield* DateTime.now);

        // Exchanges first: an ask still waiting is told of by its Exchange's drop.
        const exchanges = yield* sql<DroppedExchange>`
          SELECT e.squadron_id, e.exchange_id, e.sender_id, e.receiver_id
          FROM j5_a2a_exchange AS e
          WHERE e.status = 'open'
            AND EXISTS (
              SELECT 1 FROM j5_a2a_delivery AS d
              WHERE d.squadron_id = e.squadron_id AND d.exchange_id = e.exchange_id
                AND (d.receiver_environment_id = ${environmentId}
                  OR d.origin_environment_id = ${environmentId})
            )
          ORDER BY e.squadron_id, e.opened_seq, e.exchange_id
        `;
        let droppedExchanges = 0;
        for (const exchange of exchanges) {
          const squadronId = SquadronId.make(exchange.squadron_id);
          const exchangeId = ExchangeId.make(exchange.exchange_id);
          const onPeer = (participantId: string) =>
            findPeerCounterparty(sql, {
              squadronId,
              exchangeId,
              participantId: ParticipantId.make(participantId),
            }).pipe(Effect.map((route) => (route?.environmentId === environmentId ? route : null)));
          const remoteReceiver = yield* onPeer(exchange.receiver_id);
          const remoteSender = remoteReceiver === null ? yield* onPeer(exchange.sender_id) : null;
          const remote = remoteReceiver ?? remoteSender;
          if (remote === null) continue;
          const disposition = remoteReceiver === null ? "sender-retired" : "receiver-retired";
          yield* ledger.appendEvents({
            commandId: CommCommandId.make(
              `command:j5:a2a:peer-removed:drop:${stablePart(exchange.squadron_id)}:${stablePart(exchange.exchange_id)}`,
            ),
            squadronId,
            acceptedAt: now,
            events: peerDropEvents({
              exchange,
              disposition,
              cause: {
                kind: "peer-removed",
                participantId: ParticipantId.make(
                  remoteReceiver === null ? exchange.sender_id : exchange.receiver_id,
                ),
                squadronId: remote.squadronId,
              },
              localSquadronId: exchange.squadron_id,
              noticeText: formatPeerDropNotice({ exchangeId, disposition, because }),
              createdAt: now,
            }),
          });
          droppedExchanges += 1;
        }

        const waiting = yield* sql<WaitingRow>`
          SELECT squadron_id, message_id, sender_id, receiver_id, exchange_id, exchange_role,
            correlation_id
          FROM j5_a2a_delivery
          WHERE receiver_environment_id = ${environmentId}
            AND status IN ('pending', 'retry_scheduled', 'alarmed')
          ORDER BY sent_seq, squadron_id, message_id
        `;
        for (const row of waiting) {
          // A refusal already told the sender of an alarmed row, and an ask's
          // sender is told by its Exchange's drop.
          const alreadyTold =
            (yield* sql`
              SELECT 1 FROM j5_a2a_delivery
              WHERE squadron_id = ${row.squadron_id}
                AND message_id = ${notDeliveredNoticeMessageId(row)}
            `).length > 0;
          const tell = row.exchange_role !== "ask" && canBeNotified(row.sender_id) && !alreadyTold;
          yield* ledger.appendEvents({
            commandId: CommCommandId.make(
              `command:j5:a2a:peer-removed:cancel:${stablePart(row.squadron_id)}:${stablePart(row.message_id)}`,
            ),
            squadronId: SquadronId.make(row.squadron_id),
            acceptedAt: now,
            events: [
              {
                kind: "message.cancelled",
                sender: ParticipantId.make(row.sender_id),
                receiver: ParticipantId.make(row.receiver_id),
                exchangeId: row.exchange_id === null ? null : ExchangeId.make(row.exchange_id),
                correlationId: CorrelationId.make(row.correlation_id),
                payload: { messageId: LedgerMessageId.make(row.message_id), reason: `${because}.` },
                createdAt: now,
              },
              ...(tell
                ? [
                    notDeliveredNoticeEvent({
                      message: row,
                      serverName,
                      reason: `${because}.`,
                      createdAt: now,
                    }),
                  ]
                : []),
            ],
          });
        }

        // The notices are queued here, outside the delivery worker: wake it.
        if (droppedExchanges > 0 || waiting.length > 0) yield* worker.notify;
        const { removed } = yield* peers.remove(environmentId);
        return { removed, cancelledMessages: waiting.length, droppedExchanges };
      }).pipe(Effect.withSpan("j5.a2a.peer.remove"));

    return PeerRemovalService.of({ remove });
  }),
);
