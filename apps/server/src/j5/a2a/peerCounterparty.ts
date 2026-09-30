import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { type ExchangeId, type ParticipantId, SquadronId } from "./contracts.ts";

/** Where a participant lives when it is on a peer server. */
export interface PeerCounterparty {
  readonly environmentId: string;
  readonly squadronId: SquadronId;
}

interface RouteRow {
  readonly environment_id: string;
  readonly squadron_id: string;
}

/**
 * The ledger already knows which peer server a participant is on: an ask that
 * reached it left a delivery row naming the receiver's environment, and an ask
 * it sent here left a received row naming its origin. This is the one place
 * that reads those rows, and it answers two questions with one rule each.
 *
 * For an open Exchange, the route it was opened on is the route: the earliest
 * row for that Exchange, so a participant that later appears on another peer
 * cannot move a live Exchange. For a new send, the latest route the ledger has
 * seen for the participant is the best guess.
 */
export const findPeerCounterparty = Effect.fn("j5.a2a.peerCounterparty")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly squadronId: SquadronId;
    readonly exchangeId: ExchangeId;
    readonly participantId: ParticipantId;
  },
) {
  const outbound = yield* sql<RouteRow>`
    SELECT receiver_environment_id AS environment_id, receiver_squadron_id AS squadron_id
    FROM j5_a2a_delivery
    WHERE squadron_id = ${input.squadronId}
      AND exchange_id = ${input.exchangeId}
      AND receiver_id = ${input.participantId}
      AND receiver_environment_id IS NOT NULL
    ORDER BY sent_seq
    LIMIT 1
  `;
  if (outbound[0] !== undefined) return toCounterparty(outbound[0]);
  const inbound = yield* sql<RouteRow>`
    SELECT
      json_extract(payload, '$.originEnvironmentId') AS environment_id,
      json_extract(payload, '$.originSquadronId') AS squadron_id
    FROM j5_a2a_comm_event
    WHERE squadron_id = ${input.squadronId}
      AND kind = 'message.received'
      AND exchange_id = ${input.exchangeId}
      AND sender = ${input.participantId}
      AND json_extract(payload, '$.originEnvironmentId') IS NOT NULL
    ORDER BY seq
    LIMIT 1
  `;
  return inbound[0] === undefined ? null : toCounterparty(inbound[0]);
});

/** The latest route the ledger recorded for a participant, for a send that opens nothing yet. */
export const findPeerRoute = Effect.fn("j5.a2a.peerRoute")(function* (
  sql: SqlClient.SqlClient,
  participantId: ParticipantId,
) {
  const outbound = yield* sql<RouteRow>`
    SELECT receiver_environment_id AS environment_id, receiver_squadron_id AS squadron_id
    FROM j5_a2a_delivery
    WHERE receiver_id = ${participantId} AND receiver_environment_id IS NOT NULL
    ORDER BY sent_seq DESC
    LIMIT 1
  `;
  if (outbound[0] !== undefined) return toCounterparty(outbound[0]);
  const inbound = yield* sql<RouteRow>`
    SELECT
      json_extract(payload, '$.originEnvironmentId') AS environment_id,
      json_extract(payload, '$.originSquadronId') AS squadron_id
    FROM j5_a2a_comm_event
    WHERE kind = 'message.received'
      AND sender = ${participantId}
      AND json_extract(payload, '$.originEnvironmentId') IS NOT NULL
    ORDER BY seq DESC
    LIMIT 1
  `;
  return inbound[0] === undefined ? null : toCounterparty(inbound[0]);
});

/** Whether any recorded route places the participant on a server other than the one given. */
export const isRoutedElsewhere = Effect.fn("j5.a2a.peerRoutedElsewhere")(function* (
  sql: SqlClient.SqlClient,
  participantId: ParticipantId,
  environmentId: string,
) {
  const rows = yield* sql<{ readonly elsewhere: number }>`
    SELECT (
      EXISTS (
        SELECT 1 FROM j5_a2a_delivery
        WHERE receiver_id = ${participantId}
          AND receiver_environment_id IS NOT NULL
          AND receiver_environment_id <> ${environmentId}
      )
      OR EXISTS (
        SELECT 1 FROM j5_a2a_comm_event
        WHERE kind = 'message.received'
          AND sender = ${participantId}
          AND json_extract(payload, '$.originEnvironmentId') IS NOT NULL
          AND json_extract(payload, '$.originEnvironmentId') <> ${environmentId}
      )
    ) AS elsewhere
  `;
  return rows[0]?.elsewhere === 1;
});

const toCounterparty = (row: RouteRow): PeerCounterparty => ({
  environmentId: row.environment_id,
  squadronId: SquadronId.make(row.squadron_id),
});
