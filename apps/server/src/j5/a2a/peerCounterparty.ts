import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { type ExchangeId, type ParticipantId, SquadronId } from "./contracts.ts";

/** Where an Exchange's other party lives when that party is on a peer server. */
export interface PeerCounterparty {
  readonly environmentId: string;
  readonly squadronId: SquadronId;
}

interface OutboundRow {
  readonly receiver_environment_id: string;
  readonly receiver_squadron_id: string;
}

interface InboundRow {
  readonly origin_environment_id: string;
  readonly origin_squadron_id: string;
}

/**
 * The ledger already knows whether an Exchange crossed servers: the ask that
 * opened it either went out to a peer (a delivery row naming the receiver's
 * environment) or came in from one (a received row naming its origin). Platform
 * notices about the Exchange read this so they travel the same path back.
 */
export const findPeerCounterparty = Effect.fn("j5.a2a.peerCounterparty")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly squadronId: SquadronId;
    readonly exchangeId: ExchangeId;
    readonly participantId: ParticipantId;
  },
) {
  const outbound = yield* sql<OutboundRow>`
    SELECT receiver_environment_id, receiver_squadron_id
    FROM j5_a2a_delivery
    WHERE squadron_id = ${input.squadronId}
      AND exchange_id = ${input.exchangeId}
      AND receiver_id = ${input.participantId}
      AND receiver_environment_id IS NOT NULL
    ORDER BY sent_seq
    LIMIT 1
  `;
  if (outbound[0] !== undefined) {
    return {
      environmentId: outbound[0].receiver_environment_id,
      squadronId: SquadronId.make(outbound[0].receiver_squadron_id),
    } satisfies PeerCounterparty;
  }
  const inbound = yield* sql<InboundRow>`
    SELECT
      json_extract(payload, '$.originEnvironmentId') AS origin_environment_id,
      json_extract(payload, '$.originSquadronId') AS origin_squadron_id
    FROM j5_a2a_comm_event
    WHERE squadron_id = ${input.squadronId}
      AND kind = 'message.received'
      AND exchange_id = ${input.exchangeId}
      AND sender = ${input.participantId}
      AND json_extract(payload, '$.originEnvironmentId') IS NOT NULL
    ORDER BY seq
    LIMIT 1
  `;
  if (inbound[0] !== undefined) {
    return {
      environmentId: inbound[0].origin_environment_id,
      squadronId: SquadronId.make(inbound[0].origin_squadron_id),
    } satisfies PeerCounterparty;
  }
  return null;
});
