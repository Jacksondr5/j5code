import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { CommCommandId, ExchangeId, ParticipantId, SquadronId } from "./contracts.ts";
import { type DroppedExchange, formatPeerDropNotice, peerDropEvents } from "./deliveryNotices.ts";
import {
  A2ADeliveryWorker,
  type A2ADeliveryWorkerError,
  droppedExchangeKey,
} from "./DeliveryWorker.ts";
import { A2ALedger, type A2ALedgerError } from "./LedgerService.ts";
import { findPeerCounterparty } from "./peerCounterparty.ts";
import { PeerRegistryService, type PeerSessionReadError } from "./PeerRegistryService.ts";

/**
 * Removing a peer wipes the slate on this server, in every link mode. Every
 * open Exchange with a participant on the peer is dropped, with the drop
 * notice to the party here; every message still waiting to reach the peer,
 * stored, retrying, alarmed or handed out, is cancelled by the delivery worker,
 * and its sender gets a not-delivered notice unless its Exchange's drop already
 * told it. Then the peer's record goes. Peering again starts empty. Each step
 * is idempotent, so a removal that failed partway is finished by running it
 * again.
 */

export interface PeerRemovalResult {
  readonly removed: boolean;
  readonly cancelledMessages: number;
  readonly droppedExchanges: number;
}

export interface PeerRemovalServiceShape {
  readonly remove: (
    environmentId: string,
  ) => Effect.Effect<
    PeerRemovalResult,
    SqlError | A2ALedgerError | A2ADeliveryWorkerError | PeerSessionReadError
  >;
}

export class PeerRemovalService extends Context.Service<
  PeerRemovalService,
  PeerRemovalServiceShape
>()("t3/j5/a2a/PeerRemovalService") {}

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
          SELECT e.project_id, e.exchange_id, e.sender_id, e.receiver_id
          FROM j5_a2a_exchange AS e
          WHERE e.status = 'open'
            AND EXISTS (
              SELECT 1 FROM j5_a2a_delivery AS d
              WHERE d.project_id = e.project_id AND d.exchange_id = e.exchange_id
                AND (d.receiver_environment_id = ${environmentId}
                  OR d.origin_environment_id = ${environmentId})
            )
          ORDER BY e.project_id, e.opened_seq, e.exchange_id
        `;
        const dropped = new Set<string>();
        for (const exchange of exchanges) {
          const squadronId = SquadronId.make(exchange.project_id);
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
          // One that closed since it was read is left closed.
          const appended = yield* ledger.appendEventsIfExchangeOpen(
            {
              commandId: CommCommandId.make(
                `command:j5:a2a:peer-removed:drop:${stablePart(exchange.project_id)}:${stablePart(exchange.exchange_id)}`,
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
                  projectId: remote.squadronId,
                },
                localSquadronId: exchange.project_id,
                noticeText: formatPeerDropNotice({ exchangeId, disposition, because }),
                createdAt: now,
              }),
            },
            exchangeId,
          );
          if (appended !== null) {
            dropped.add(droppedExchangeKey(exchange.project_id, exchange.exchange_id));
          }
        }

        const cancelledMessages = yield* worker.cancelPeerDeliveries({
          environmentId,
          serverName,
          reason: `${because}.`,
          droppedExchanges: dropped,
        });

        // The drop notices are queued here, outside the delivery worker: wake it.
        if (dropped.size > 0) yield* worker.notify;
        const { removed } = yield* peers.remove(environmentId);
        return { removed, cancelledMessages, droppedExchanges: dropped.size };
      }).pipe(Effect.withSpan("j5.a2a.peer.remove"));

    return PeerRemovalService.of({ remove });
  }),
);
