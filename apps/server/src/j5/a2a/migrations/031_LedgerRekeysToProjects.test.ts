// @effect-diagnostics preferSchemaOverJson:off - fixtures and assertions are raw stored JSON.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../../persistence/Migrations.ts";
import { LedgerProjectId, ParticipantId } from "../contracts.ts";
import { runJ5A2AMigrations } from "../Migrations.ts";
import { PlacementCommandId } from "../placementContracts.ts";
import { layer as placementLayer, ParticipantPlacementService } from "../PlacementService.ts";

const memory = Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }));

const AT = "2026-10-01T00:00:00.000Z";
const ALPHA = { squadron: "squadron:alpha", project: "project-alpha" };
const BETA = { squadron: "squadron:beta", project: "project-beta" };
// Its project is soft-deleted upstream before the migration runs.
const GONE = { squadron: "squadron:gone", project: "project-gone" };
const PEER_ENVIRONMENT = "environment:peer";
// A peer's Squadron id that happens to equal a local one, as two servers seeded from one
// database copy would have. Only the column rules can tell it apart.
const PEER_SQUADRON = ALPHA.squadron;
const PEER_RECEIVE = "command:j5:a2a:peer:receive:environment%3Apeer:";

const prepare = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = ON`;
  yield* runMigrations();
  yield* runJ5A2AMigrations({ toMigrationInclusive: 30 });
  return sql;
});

const insertProject = (sql: SqlClient.SqlClient, projectId: string, deletedAt: string | null) =>
  sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
    ) VALUES (${projectId}, ${`Title of ${projectId}`}, ${`/tmp/${projectId}`}, '[]', ${AT}, ${AT}, ${deletedAt})
  `;

const insertSquadron = (
  sql: SqlClient.SqlClient,
  home: { readonly squadron: string; readonly project: string },
) =>
  Effect.gen(function* () {
    yield* sql`
      INSERT INTO j5_a2a_squadron (id, name, created_at)
      VALUES (${home.squadron}, ${`Name of ${home.squadron}`}, ${AT})
    `;
    yield* sql`
      INSERT INTO j5_a2a_squadron_project_reference (squadron_id, project_id, ordinal, created_at)
      VALUES (${home.squadron}, ${home.project}, 0, ${AT})
    `;
  });

interface EventInput {
  readonly squadron: string;
  readonly seq: number;
  readonly kind: string;
  readonly sender?: string;
  readonly receiver?: string;
  readonly exchangeId?: string;
  readonly correlationId?: string;
  readonly commandId?: string;
  readonly payload: unknown;
}

const insertEvent = (sql: SqlClient.SqlClient, event: EventInput) =>
  Effect.gen(function* () {
    const commandId = event.commandId ?? `command:${event.squadron}:${event.seq}`;
    yield* sql`
      INSERT INTO j5_a2a_comm_event (
        seq, squadron_id, kind, sender, receiver, exchange_id, correlation_id, payload, created_at,
        command_id
      ) VALUES (
        ${event.seq}, ${event.squadron}, ${event.kind}, ${event.sender ?? null},
        ${event.receiver ?? null}, ${event.exchangeId ?? null}, ${event.correlationId ?? null},
        ${JSON.stringify(event.payload)}, ${AT}, ${commandId}
      )
    `;
    yield* sql`
      INSERT INTO j5_a2a_comm_command_receipt (
        command_id, squadron_id, command_type, accepted_at, result_seq
      ) VALUES (${commandId}, ${event.squadron}, 'comm.append', ${AT}, ${event.seq})
      ON CONFLICT (command_id) DO NOTHING
    `;
  });

const joined = (squadron: string, seq: number, thread: string): EventInput => ({
  squadron,
  seq,
  kind: "participant.joined",
  receiver: `agent:${thread}`,
  payload: { participant: { kind: "agent", id: `agent:${thread}`, threadId: thread } },
});

const sent = (input: {
  readonly messageId: string;
  readonly origin: string;
  readonly receiver: string;
  readonly role: string;
  readonly extra?: Record<string, unknown>;
}) => ({
  messageId: input.messageId,
  text: `text of ${input.messageId}`,
  originSquadronId: input.origin,
  receiverSquadronId: input.receiver,
  exchangeRole: input.role,
  envelopeChannel: "peer",
  ...input.extra,
});

const insertDelivery = (
  sql: SqlClient.SqlClient,
  delivery: {
    readonly squadron: string;
    readonly messageId: string;
    readonly sentSeq: number;
    readonly receiverSquadron: string;
    readonly exchangeId?: string;
    readonly role: string;
    readonly originSquadron?: string;
    readonly originEnvironment?: string;
    readonly receiverEnvironment?: string;
  },
) => sql`
  INSERT INTO j5_a2a_delivery (
    squadron_id, message_id, command_id, sent_seq, sender_id, receiver_id, receiver_squadron_id,
    exchange_id, exchange_role, correlation_id, message_text, status, created_at, updated_at,
    envelope_channel, origin_squadron_id, origin_environment_id, receiver_environment_id
  ) VALUES (
    ${delivery.squadron}, ${delivery.messageId}, ${`command:delivery:${delivery.messageId}`},
    ${delivery.sentSeq}, 'agent:sender', 'agent:receiver', ${delivery.receiverSquadron},
    ${delivery.exchangeId ?? null}, ${delivery.role}, ${`correlation:${delivery.messageId}`},
    'text', 'delivered', ${AT}, ${AT}, 'peer', ${delivery.originSquadron ?? null},
    ${delivery.originEnvironment ?? null}, ${delivery.receiverEnvironment ?? null}
  )
`;

// What the previous version stored for a placement. The code that wrote it is gone, so the text is
// written out here: it is `creationFingerprint` in PlacementService.ts as it stood before this
// migration, with the Squadron under the key it used then.
const placementFingerprintBeforeRekey = JSON.stringify({
  type: "record_creation",
  squadronId: ALPHA.squadron,
  participantId: "agent:thread-a",
  actor: "agent",
  provenanceKind: "unknown",
  provenanceParticipantId: null,
  provenanceSource: "native_or_unobserved",
  createdAt: AT,
});

/** A one-to-one ledger: three Squadrons, local and cross-Squadron traffic, and a peer server. */
const seedLedger = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* insertProject(sql, ALPHA.project, null);
    yield* insertProject(sql, BETA.project, null);
    yield* insertProject(sql, GONE.project, AT);
    yield* insertSquadron(sql, ALPHA);
    yield* insertSquadron(sql, BETA);
    yield* insertSquadron(sql, GONE);

    const events: ReadonlyArray<EventInput> = [
      joined(ALPHA.squadron, 1, "thread-a"),
      joined(BETA.squadron, 1, "thread-b"),
      joined(GONE.squadron, 1, "thread-g"),
      // An ask from alpha to beta, answered: both ledgers hold the Exchange.
      {
        squadron: ALPHA.squadron,
        seq: 2,
        kind: "exchange.opened",
        sender: "agent:thread-a",
        receiver: "agent:thread-b",
        exchangeId: "exchange:cross",
        payload: { intent: "ask", urgency: null },
      },
      {
        squadron: ALPHA.squadron,
        seq: 3,
        kind: "message.sent",
        sender: "agent:thread-a",
        receiver: "agent:thread-b",
        exchangeId: "exchange:cross",
        correlationId: "correlation:ask",
        payload: sent({
          messageId: "message:ask",
          origin: ALPHA.squadron,
          receiver: BETA.squadron,
          role: "ask",
        }),
      },
      {
        squadron: BETA.squadron,
        seq: 2,
        kind: "message.received",
        sender: "agent:thread-a",
        receiver: "agent:thread-b",
        exchangeId: "exchange:cross",
        correlationId: "correlation:ask",
        payload: {
          originSquadronId: ALPHA.squadron,
          message: sent({
            messageId: "message:ask",
            origin: ALPHA.squadron,
            receiver: BETA.squadron,
            role: "ask",
          }),
        },
      },
      {
        squadron: BETA.squadron,
        seq: 3,
        kind: "message.sent",
        sender: "agent:thread-b",
        receiver: "agent:thread-a",
        exchangeId: "exchange:cross",
        correlationId: "correlation:reply",
        payload: sent({
          messageId: "message:reply",
          origin: BETA.squadron,
          receiver: ALPHA.squadron,
          role: "reply",
        }),
      },
      {
        squadron: ALPHA.squadron,
        seq: 4,
        kind: "exchange.closed",
        sender: "agent:thread-a",
        receiver: "agent:thread-b",
        exchangeId: "exchange:cross",
        payload: { replyMessageId: "message:reply" },
      },
      // To a peer server: the receiver's id is the peer's.
      {
        squadron: ALPHA.squadron,
        seq: 5,
        kind: "message.sent",
        sender: "agent:thread-a",
        receiver: "agent:remote",
        correlationId: "correlation:to-peer",
        payload: sent({
          messageId: "message:to-peer",
          origin: ALPHA.squadron,
          receiver: PEER_SQUADRON,
          role: "none",
          extra: { receiverEnvironmentId: PEER_ENVIRONMENT },
        }),
      },
      // A terminal notice headed to a peer: its fact names this server's ledger.
      {
        squadron: ALPHA.squadron,
        seq: 6,
        kind: "message.sent",
        sender: "agent:thread-a",
        receiver: "agent:remote",
        correlationId: "correlation:terminal",
        payload: sent({
          messageId: "message:terminal",
          origin: ALPHA.squadron,
          receiver: PEER_SQUADRON,
          role: "terminal_notice",
          extra: {
            receiverEnvironmentId: PEER_ENVIRONMENT,
            terminal: {
              kind: "dropped",
              cause: {
                kind: "participant-deleted",
                participantId: "agent:thread-a",
                squadronId: ALPHA.squadron,
              },
            },
          },
        }),
      },
      // From a peer server: every id in it is the peer's.
      {
        squadron: BETA.squadron,
        seq: 4,
        kind: "message.received",
        sender: "agent:remote",
        receiver: "agent:thread-b",
        correlationId: "correlation:from-peer",
        commandId: `${PEER_RECEIVE}message%3Afrom-peer`,
        payload: {
          originSquadronId: PEER_SQUADRON,
          originEnvironmentId: PEER_ENVIRONMENT,
          message: sent({
            messageId: "message:from-peer",
            origin: PEER_SQUADRON,
            // The receiving side wrote its own Squadron here, whoever sent the message.
            receiver: BETA.squadron,
            role: "none",
            extra: {
              terminal: {
                kind: "dropped",
                cause: {
                  kind: "participant-deleted",
                  participantId: "agent:remote",
                  squadronId: PEER_SQUADRON,
                },
              },
            },
          }),
        },
      },
      // Dropped by this server's lifecycle, and dropped on a peer's word.
      {
        squadron: BETA.squadron,
        seq: 5,
        kind: "exchange.dropped",
        sender: "agent:thread-b",
        receiver: "agent:thread-a",
        exchangeId: "exchange:dropped-here",
        payload: {
          disposition: "receiver-retired",
          cause: {
            kind: "participant-deleted",
            participantId: "agent:thread-a",
            squadronId: BETA.squadron,
          },
        },
      },
      {
        squadron: BETA.squadron,
        seq: 6,
        kind: "exchange.dropped",
        sender: "agent:thread-b",
        receiver: "agent:remote",
        exchangeId: "exchange:dropped-by-peer",
        commandId: `${PEER_RECEIVE}message%3Apeer-terminal`,
        payload: {
          disposition: "receiver-retired",
          cause: {
            kind: "participant-deleted",
            participantId: "agent:remote",
            squadronId: PEER_SQUADRON,
          },
        },
      },
      // Dropped by this server because the peer was removed: the cause names the peer's agent.
      {
        squadron: BETA.squadron,
        seq: 7,
        kind: "exchange.dropped",
        sender: "agent:thread-b",
        receiver: "agent:remote",
        exchangeId: "exchange:dropped-with-peer",
        payload: {
          disposition: "receiver-retired",
          cause: { kind: "peer-removed", participantId: "agent:remote", squadronId: PEER_SQUADRON },
        },
      },
    ];
    for (const event of events) yield* insertEvent(sql, event);

    yield* sql`
      INSERT INTO j5_a2a_squadron_membership (
        squadron_id, participant_id, participant_kind, thread_id, joined_seq, updated_seq, payload
      ) VALUES
        (${ALPHA.squadron}, 'agent:thread-a', 'agent', 'thread-a', 1, 1, '{}'),
        (${BETA.squadron}, 'agent:thread-b', 'agent', 'thread-b', 1, 1, '{}'),
        (${GONE.squadron}, 'agent:thread-g', 'agent', 'thread-g', 1, 1, '{}')
    `;
    yield* sql`
      INSERT INTO j5_a2a_exchange (
        squadron_id, exchange_id, sender_id, receiver_id, status, intent, urgency, opened_seq,
        closed_seq, created_at, updated_at
      ) VALUES
        (${ALPHA.squadron}, 'exchange:cross', 'agent:thread-a', 'agent:thread-b', 'closed', 'ask', NULL, 2, 4, ${AT}, ${AT}),
        (${BETA.squadron}, 'exchange:cross', 'agent:thread-a', 'agent:thread-b', 'closed', 'ask', NULL, 2, 3, ${AT}, ${AT}),
        (${BETA.squadron}, 'exchange:dropped-here', 'agent:thread-b', 'human:operator', 'dropped', 'ask', 'soon', 5, 5, ${AT}, ${AT}),
        (${BETA.squadron}, 'exchange:dropped-by-peer', 'agent:remote', 'human:operator', 'dropped', 'ask', 'soon', 6, 6, ${AT}, ${AT})
    `;
    yield* insertDelivery(sql, {
      squadron: ALPHA.squadron,
      messageId: "message:ask",
      sentSeq: 3,
      receiverSquadron: BETA.squadron,
      exchangeId: "exchange:cross",
      role: "ask",
    });
    yield* insertDelivery(sql, {
      squadron: ALPHA.squadron,
      messageId: "message:to-peer",
      sentSeq: 5,
      receiverSquadron: PEER_SQUADRON,
      role: "none",
      receiverEnvironment: PEER_ENVIRONMENT,
    });
    yield* insertDelivery(sql, {
      squadron: BETA.squadron,
      messageId: "message:from-peer",
      sentSeq: 4,
      receiverSquadron: BETA.squadron,
      role: "none",
      originSquadron: PEER_SQUADRON,
      originEnvironment: PEER_ENVIRONMENT,
    });

    const localCause = JSON.stringify({
      kind: "participant-deleted",
      participantId: "agent:thread-a",
      squadronId: BETA.squadron,
    });
    const peerCause = JSON.stringify({
      kind: "participant-deleted",
      participantId: "agent:remote",
      squadronId: PEER_SQUADRON,
    });
    yield* sql`
      INSERT INTO j5_a2a_human_inbox (
        person_id, squadron_id, exchange_id, sender_id, intent, urgency, latest_message_id,
        latest_message, opened_seq, opened_at, status, terminal_seq, terminal_at,
        terminal_disposition, terminal_cause
      ) VALUES
        ('human:operator', ${BETA.squadron}, 'exchange:dropped-here', 'agent:thread-b', 'ask', 'soon', 'message:x', 'x', 5, ${AT}, 'dropped', 5, ${AT}, 'receiver-retired', ${localCause}),
        ('human:operator', ${BETA.squadron}, 'exchange:dropped-by-peer', 'agent:remote', 'ask', 'soon', 'message:y', 'y', 6, ${AT}, 'dropped', 6, ${AT}, 'receiver-retired', ${peerCause})
    `;
    yield* sql`
      INSERT INTO j5_a2a_human_inbox_data (
        origin_squadron_id, message_id, exchange_id, sender_id, receiver_id, payload, created_at
      ) VALUES (${BETA.squadron}, 'message:x', 'exchange:dropped-here', 'agent:thread-b', 'human:operator', '{}', ${AT})
    `;
    yield* sql`
      INSERT INTO j5_a2a_machine_participant (participant_id, squadron_id, name, joined_seq, created_at)
      VALUES ('machine:watchdog', ${GONE.squadron}, 'watchdog', 1, ${AT})
    `;
    yield* sql`
      INSERT INTO j5_a2a_participant_placement (
        squadron_id, participant_id, provenance_kind, created_event_seq, updated_event_seq
      ) VALUES (${ALPHA.squadron}, 'agent:thread-a', 'unknown', 1, 1)
    `;
    yield* sql`
      INSERT INTO j5_a2a_placement_event (
        seq, command_id, request_fingerprint, squadron_id, participant_id, kind, actor,
        provenance_kind, created_at
      ) VALUES (
        1, 'command:placement:a',
        ${placementFingerprintBeforeRekey},
        ${ALPHA.squadron}, 'agent:thread-a', 'participant.placement_created', 'agent', 'unknown', ${AT}
      )
    `;
    yield* sql`
      INSERT INTO j5_agent_crew_instance (
        id, squadron_id, captain_participant_id, captain_thread_id, display_name, brief, version,
        created_at
      ) VALUES ('crew:one', ${ALPHA.squadron}, 'agent:thread-a', 'thread-a', 'Crew', 'brief', 1, ${AT})
    `;
    yield* sql`
      INSERT INTO j5_agent_crew_member (
        crew_instance_id, seat_name, participant_id, thread_id, ordinal, added_version
      ) VALUES ('crew:one', 'builder', 'agent:thread-seat', 'thread-seat', 0, 1)
    `;
    yield* sql`
      INSERT INTO j5_agent_crew_proposal (
        id, squadron_id, captain_participant_id, captain_thread_id, kind, status, brief,
        display_name, requested_seats, created_at
      ) VALUES ('proposal:one', ${ALPHA.squadron}, 'agent:thread-a', 'thread-a', 'roster', 'open', 'brief', 'Crew', '[]', ${AT})
    `;
  });

/** Every J5 table's rows, with the tables that vanish or appear left out by the caller. */
const dumpLedger = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const tables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND (name LIKE 'j5_a2a_%' OR name LIKE 'j5_agent_crew_%')
      ORDER BY name
    `;
    const dump: Record<string, ReadonlyArray<string>> = {};
    for (const { name } of tables) {
      const rows = yield* sql.unsafe<Record<string, unknown>>(`SELECT * FROM ${name}`);
      dump[name] = rows.map((row) => JSON.stringify(row)).toSorted();
    }
    return dump;
  });

const payloadOf = (sql: SqlClient.SqlClient, projectId: string, seq: number) =>
  sql<{ readonly payload: string }>`
    SELECT payload FROM j5_a2a_comm_event WHERE project_id = ${projectId} AND seq = ${seq}
  `.pipe(Effect.map((rows) => JSON.parse(rows[0]?.payload ?? "null")));

it.effect("moves each Squadron's ledger to its project without adding or losing a row", () =>
  Effect.gen(function* () {
    const sql = yield* prepare;
    yield* seedLedger(sql);
    const before = yield* dumpLedger(sql);

    yield* runJ5A2AMigrations();

    const after = yield* dumpLedger(sql);
    const renamed = (name: string) =>
      name === "j5_a2a_squadron_membership"
        ? "j5_a2a_membership"
        : name === "j5_a2a_squadron"
          ? "j5_a2a_project_ledger"
          : name;
    for (const [name, rows] of Object.entries(before)) {
      if (name === "j5_a2a_squadron_project_reference" || name === "j5_a2a_migrations") continue;
      assert.strictEqual(after[renamed(name)]?.length, rows.length, name);
    }
    assert.isUndefined(after.j5_a2a_squadron);
    assert.isUndefined(after.j5_a2a_squadron_project_reference);

    // Sequence numbers are per ledger and did not move.
    const events = yield* sql<{ readonly project_id: string; readonly seqs: string }>`
      SELECT project_id, group_concat(seq, ',') AS seqs
      FROM (SELECT project_id, seq FROM j5_a2a_comm_event ORDER BY project_id, seq)
      GROUP BY project_id
      ORDER BY project_id
    `;
    assert.deepStrictEqual(events, [
      { project_id: ALPHA.project, seqs: "1,2,3,4,5,6" },
      { project_id: BETA.project, seqs: "1,2,3,4,5,6,7" },
      { project_id: GONE.project, seqs: "1" },
    ]);

    // A thread's home is read from its first participant.joined event.
    const homes = yield* sql<{ readonly thread_id: string; readonly project_id: string }>`
      SELECT json_extract(payload, '$.participant.threadId') AS thread_id, project_id
      FROM j5_a2a_comm_event
      WHERE kind = 'participant.joined'
      ORDER BY thread_id
    `;
    assert.deepStrictEqual(homes, [
      { thread_id: "thread-a", project_id: ALPHA.project },
      { thread_id: "thread-b", project_id: BETA.project },
      { thread_id: "thread-g", project_id: GONE.project },
    ]);

    // The answered cross-Squadron Exchange is still one Exchange held by both ledgers.
    const exchange = yield* sql<{ readonly project_id: string; readonly status: string }>`
      SELECT project_id, status FROM j5_a2a_exchange
      WHERE exchange_id = 'exchange:cross' ORDER BY project_id
    `;
    assert.deepStrictEqual(exchange, [
      { project_id: ALPHA.project, status: "closed" },
      { project_id: BETA.project, status: "closed" },
    ]);
    const ask = yield* payloadOf(sql, ALPHA.project, 3);
    assert.strictEqual(ask.originProjectId, ALPHA.project);
    assert.strictEqual(ask.receiverProjectId, BETA.project);
    assert.isUndefined(ask.originSquadronId);
    assert.isUndefined(ask.receiverSquadronId);
    const askReceived = yield* payloadOf(sql, BETA.project, 2);
    assert.strictEqual(askReceived.originProjectId, ALPHA.project);
    assert.strictEqual(askReceived.message.originProjectId, ALPHA.project);
    assert.strictEqual(askReceived.message.receiverProjectId, BETA.project);
    const reply = yield* payloadOf(sql, BETA.project, 3);
    assert.strictEqual(reply.originProjectId, BETA.project);
    assert.strictEqual(reply.receiverProjectId, ALPHA.project);

    // The record of what the Squadrons were.
    const retired = yield* sql`
      SELECT squadron_id, name, project_id FROM j5_a2a_retired_squadron ORDER BY squadron_id
    `;
    assert.deepStrictEqual(retired, [
      { squadron_id: ALPHA.squadron, name: `Name of ${ALPHA.squadron}`, project_id: ALPHA.project },
      { squadron_id: BETA.squadron, name: `Name of ${BETA.squadron}`, project_id: BETA.project },
      { squadron_id: GONE.squadron, name: `Name of ${GONE.squadron}`, project_id: GONE.project },
    ]);

    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
    const leftovers = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master
      WHERE sql LIKE '%squadron%' AND name NOT LIKE 'j5_a2a_retired_squadron%'
    `;
    assert.deepStrictEqual(leftovers, []);
  }).pipe(memory),
);

it.effect("rewrites this server's ids in stored JSON and leaves a peer server's alone", () =>
  Effect.gen(function* () {
    const sql = yield* prepare;
    yield* seedLedger(sql);
    yield* runJ5A2AMigrations();

    // Sent to a peer: the origin is local, the receiver is the peer's even though its id equals
    // a local Squadron's.
    const toPeer = yield* payloadOf(sql, ALPHA.project, 5);
    assert.strictEqual(toPeer.originProjectId, ALPHA.project);
    assert.strictEqual(toPeer.receiverProjectId, PEER_SQUADRON);
    const terminal = yield* payloadOf(sql, ALPHA.project, 6);
    assert.deepStrictEqual(terminal.terminal.cause, {
      kind: "participant-deleted",
      participantId: "agent:thread-a",
      projectId: ALPHA.project,
    });

    // Received from a peer: the origin and the fact are the peer's, the receiver is this server's.
    const fromPeer = yield* payloadOf(sql, BETA.project, 4);
    assert.strictEqual(fromPeer.originProjectId, PEER_SQUADRON);
    assert.strictEqual(fromPeer.message.originProjectId, PEER_SQUADRON);
    assert.strictEqual(fromPeer.message.receiverProjectId, BETA.project);
    assert.strictEqual(fromPeer.message.terminal.cause.projectId, PEER_SQUADRON);
    assert.isUndefined(fromPeer.originSquadronId);
    assert.isUndefined(fromPeer.message.terminal.cause.squadronId);

    const droppedHere = yield* payloadOf(sql, BETA.project, 5);
    assert.strictEqual(droppedHere.cause.projectId, BETA.project);
    assert.isUndefined(droppedHere.cause.squadronId);
    const droppedByPeer = yield* payloadOf(sql, BETA.project, 6);
    assert.strictEqual(droppedByPeer.cause.projectId, PEER_SQUADRON);
    const droppedWithPeer = yield* payloadOf(sql, BETA.project, 7);
    assert.deepStrictEqual(droppedWithPeer.cause, {
      kind: "peer-removed",
      participantId: "agent:remote",
      projectId: PEER_SQUADRON,
    });

    const inbox = yield* sql<{ readonly exchange_id: string; readonly terminal_cause: string }>`
      SELECT exchange_id, terminal_cause FROM j5_a2a_human_inbox ORDER BY exchange_id
    `;
    assert.deepStrictEqual(
      inbox.map((row) => [row.exchange_id, JSON.parse(row.terminal_cause).projectId]),
      [
        ["exchange:dropped-by-peer", PEER_SQUADRON],
        ["exchange:dropped-here", BETA.project],
      ],
    );

    const deliveries = yield* sql`
      SELECT message_id, project_id, receiver_project_id, origin_project_id
      FROM j5_a2a_delivery ORDER BY message_id
    `;
    assert.deepStrictEqual(deliveries, [
      {
        message_id: "message:ask",
        project_id: ALPHA.project,
        receiver_project_id: BETA.project,
        origin_project_id: null,
      },
      {
        message_id: "message:from-peer",
        project_id: BETA.project,
        receiver_project_id: BETA.project,
        origin_project_id: PEER_SQUADRON,
      },
      {
        message_id: "message:to-peer",
        project_id: ALPHA.project,
        receiver_project_id: PEER_SQUADRON,
        origin_project_id: null,
      },
    ]);

    // A placement command replayed after the upgrade is compared with the stored fingerprint as
    // text, so the real service has to recognize the row the migration rewrote.
    const replayed = yield* ParticipantPlacementService.pipe(
      Effect.flatMap((placements) =>
        placements.recordCreation({
          commandId: PlacementCommandId.make("command:placement:a"),
          projectId: LedgerProjectId.make(ALPHA.project),
          participantId: ParticipantId.make("agent:thread-a"),
          actor: "agent",
          provenance: { kind: "unknown", source: "native_or_unobserved" },
          createdAt: AT,
        }),
      ),
      Effect.provide(placementLayer),
    );
    assert.isFalse(replayed.committed);
    assert.strictEqual(replayed.placement.participantId, "agent:thread-a");
    assert.deepStrictEqual(yield* sql`SELECT COUNT(*) AS events FROM j5_a2a_placement_event`, [
      { events: 1 },
    ]);
  }).pipe(memory),
);

it.effect("keeps the ledger of a Squadron whose project was soft-deleted", () =>
  Effect.gen(function* () {
    const sql = yield* prepare;
    yield* seedLedger(sql);
    yield* runJ5A2AMigrations();

    const ledger = yield* sql`
      SELECT project_id FROM j5_a2a_project_ledger WHERE project_id = ${GONE.project}
    `;
    assert.deepStrictEqual(ledger, [{ project_id: GONE.project }]);
    const members = yield* sql`
      SELECT participant_id FROM j5_a2a_membership WHERE project_id = ${GONE.project}
    `;
    assert.deepStrictEqual(members, [{ participant_id: "agent:thread-g" }]);
    const machines = yield* sql`
      SELECT participant_id FROM j5_a2a_machine_participant WHERE project_id = ${GONE.project}
    `;
    assert.deepStrictEqual(machines, [{ participant_id: "machine:watchdog" }]);
  }).pipe(memory),
);

it.effect("refuses by name a project that several Squadrons share, and changes nothing", () =>
  Effect.gen(function* () {
    const sql = yield* prepare;
    yield* seedLedger(sql);
    yield* sql`
      INSERT INTO j5_a2a_squadron (id, name, created_at)
      VALUES ('squadron:second', 'Second effort', ${AT})
    `;
    yield* sql`
      INSERT INTO j5_a2a_squadron_project_reference (squadron_id, project_id, ordinal, created_at)
      VALUES ('squadron:second', ${ALPHA.project}, 0, ${AT})
    `;
    const before = yield* dumpLedger(sql);

    const exit = yield* Effect.exit(runJ5A2AMigrations());

    const failure = String(exit);
    assert.strictEqual(exit._tag, "Failure");
    assert.include(failure, `project "Title of ${ALPHA.project}" (${ALPHA.project})`);
    assert.include(failure, `"Name of ${ALPHA.squadron}" (${ALPHA.squadron})`);
    assert.include(failure, `"Second effort" (squadron:second)`);
    assert.include(failure, "Nothing was changed.");
    assert.include(failure, "docs/j5/runbooks/dogfood-runtime.md");
    assert.deepStrictEqual(yield* dumpLedger(sql), before);
  }).pipe(memory),
);

it.effect("aborts, naming the table, when a ledger row would be left without a project", () =>
  Effect.gen(function* () {
    const sql = yield* prepare;
    yield* seedLedger(sql);
    // A Squadron that references no project: the product could not build it, storage could.
    yield* sql`
      INSERT INTO j5_a2a_squadron (id, name, created_at)
      VALUES ('squadron:adrift', 'Adrift', ${AT})
    `;
    yield* insertEvent(sql, joined("squadron:adrift", 1, "thread-adrift"));
    const before = yield* dumpLedger(sql);

    const exit = yield* Effect.exit(runJ5A2AMigrations());

    const failure = String(exit);
    assert.strictEqual(exit._tag, "Failure");
    assert.include(failure, "j5_a2a_comm_event");
    assert.include(failure, "1 left without a project");
    assert.include(failure, "Nothing was changed.");
    assert.deepStrictEqual(yield* dumpLedger(sql), before);
  }).pipe(memory),
);

it.effect("records a Squadron that had no project and no ledger, and drops it", () =>
  Effect.gen(function* () {
    const sql = yield* prepare;
    yield* seedLedger(sql);
    yield* sql`
      INSERT INTO j5_a2a_squadron (id, name, created_at)
      VALUES ('squadron:empty', 'Empty', ${AT})
    `;

    yield* runJ5A2AMigrations();

    const retired = yield* sql`
      SELECT name, project_id FROM j5_a2a_retired_squadron WHERE squadron_id = 'squadron:empty'
    `;
    assert.deepStrictEqual(retired, [{ name: "Empty", project_id: null }]);
    const ledgers = yield* sql`SELECT project_id FROM j5_a2a_project_ledger ORDER BY project_id`;
    assert.deepStrictEqual(ledgers, [
      { project_id: ALPHA.project },
      { project_id: BETA.project },
      { project_id: GONE.project },
    ]);
  }).pipe(memory),
);

// Migration 031 renames the Squadron table because dropping it would empty its cascading
// children. This pins the SQLite behaviour that decision rests on.
it.effect(
  "dropping a parent table deletes its cascading children even when checks are deferred",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* sql`CREATE TABLE parent (id TEXT PRIMARY KEY)`;
      yield* sql`CREATE TABLE cascading (parent_id TEXT REFERENCES parent(id) ON DELETE CASCADE)`;
      yield* sql`INSERT INTO parent VALUES ('a')`;
      yield* sql`INSERT INTO cascading VALUES ('a')`;

      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`PRAGMA defer_foreign_keys = ON`;
          yield* sql`DROP TABLE parent`;
        }),
      );

      assert.deepStrictEqual(yield* sql`SELECT * FROM cascading`, []);
    }).pipe(memory),
);
