import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { A2AHumanInbox, layer as humanInboxLayer } from "./HumanInboxService.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import {
  ClientReadsService,
  explainOpenInboxCountStatement,
  layer as clientReadsLayer,
} from "./ClientReadsService.ts";
import { CommCommandId, ParticipantId, SquadronId, type AgentParticipant } from "./contracts.ts";

const firstPerson = ParticipantId.make("human:person-one");
const secondPerson = ParticipantId.make("human:person-two");

const makeTestLayer = () => {
  const database = NodeSqliteClient.layerMemory();
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const inbox = humanInboxLayer.pipe(Layer.provide(ledger), Layer.provide(database));
  const clientReads = clientReadsLayer.pipe(Layer.provide(inbox), Layer.provide(database));
  return Layer.mergeAll(database, ledger, inbox, clientReads);
};

it.effect(
  "reads immutable homes and total batched identities without participant-id normalization",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* runJ5A2AMigrations();
      const ledger = yield* A2ALedger;
      const reads = yield* ClientReadsService;
      const sql = yield* SqlClient.SqlClient;

      const alpha: AgentParticipant = {
        kind: "agent",
        id: ParticipantId.make("agent:j5:a2a:thread:client-reads:alpha"),
        threadId: ThreadId.make("thread:client-reads:alpha"),
      };
      const beta: AgentParticipant = {
        kind: "agent",
        id: ParticipantId.make("agent:j5:a2a:thread%3Aclient-reads%3Abeta"),
        threadId: ThreadId.make("thread:client-reads:beta"),
      };
      const alphaSquadron = SquadronId.make("squadron:client-reads:alpha");
      const betaSquadron = SquadronId.make("squadron:client-reads:beta");
      const createdAt = "2026-08-29T00:00:00.000Z";
      const earlierDuplicateJoinAt = "2026-08-28T00:00:00.000Z";
      const laterDuplicateJoinAt = "2026-08-30T00:00:00.000Z";

      const join = Effect.fn("test.j5.a2a.clientReads.join")(function* (input: {
        readonly squadronId: SquadronId;
        readonly name: string;
        readonly agent: AgentParticipant;
      }) {
        yield* ledger.createSquadron({
          squadron: { id: input.squadronId, name: input.name, createdAt },
        });
        yield* ledger.appendEvents({
          commandId: CommCommandId.make(`command:client-reads:join:${input.agent.id}`),
          squadronId: input.squadronId,
          acceptedAt: createdAt,
          events: [
            {
              kind: "participant.joined",
              sender: null,
              receiver: input.agent.id,
              exchangeId: null,
              correlationId: null,
              payload: { participant: input.agent },
              createdAt,
            },
          ],
        });
      });
      yield* join({ squadronId: alphaSquadron, name: "Alpha Squadron", agent: alpha });
      yield* join({ squadronId: betaSquadron, name: "Beta Squadron", agent: beta });
      yield* ledger.appendEvents({
        commandId: CommCommandId.make("command:client-reads:leave:beta"),
        squadronId: betaSquadron,
        acceptedAt: createdAt,
        events: [
          {
            kind: "participant.left",
            sender: null,
            receiver: beta.id,
            exchangeId: null,
            correlationId: null,
            payload: { participant: beta },
            createdAt,
          },
        ],
      });
      const legacyHuman = ParticipantId.make("human:legacy-history");
      const duplicateHistory = ParticipantId.make("agent:client-reads:duplicate-history");
      yield* sql`
        INSERT INTO j5_a2a_comm_event (
          seq, squadron_id, kind, sender, receiver, exchange_id, correlation_id,
          payload, created_at, command_id
        ) VALUES (
          2, ${alphaSquadron}, 'participant.joined', NULL, ${duplicateHistory}, NULL, NULL,
          json_object(
            'participant',
            json_object(
              'kind', 'agent',
              'id', ${duplicateHistory},
              'threadId', 'thread:client-reads:duplicate-history:first'
            )
          ),
          ${laterDuplicateJoinAt}, NULL
        )
      `;
      yield* sql`
        INSERT INTO j5_a2a_comm_event (
          seq, squadron_id, kind, sender, receiver, exchange_id, correlation_id,
          payload, created_at, command_id
        ) VALUES (
          3, ${betaSquadron}, 'participant.joined', NULL, ${duplicateHistory}, NULL, NULL,
          json_object(
            'participant',
            json_object(
              'kind', 'agent',
              'id', ${duplicateHistory},
              'threadId', 'thread:client-reads:duplicate-history:second'
            )
          ),
          ${earlierDuplicateJoinAt}, NULL
        )
      `;
      yield* sql`
        INSERT INTO j5_a2a_comm_event (
          seq, squadron_id, kind, sender, receiver, exchange_id, correlation_id,
          payload, created_at, command_id
        ) VALUES (
          3, ${alphaSquadron}, 'participant.joined', NULL, ${legacyHuman}, NULL, NULL,
          json_object('participant', json_object('kind', 'human', 'id', ${legacyHuman})),
          ${createdAt}, NULL
        )
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode,
          interaction_mode, active_provider_thread_id, created_at, updated_at,
          archived_at, deleted_at, payload_json
        ) VALUES (
          (${alpha.threadId}), 'project:client-reads', 'Alpha Thread', 'codex', 'full-access',
          'default', NULL, ${createdAt}, ${createdAt}, NULL, NULL, '{}'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode,
          interaction_mode, active_provider_thread_id, created_at, updated_at,
          archived_at, deleted_at, payload_json
        ) VALUES (
          ('thread:client-reads:duplicate-history:second'), 'project:client-reads',
          'Earlier Duplicate Thread', 'codex', 'full-access',
          'default', NULL, ${createdAt}, ${createdAt}, NULL, NULL, '{}'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode,
          interaction_mode, active_provider_thread_id, created_at, updated_at,
          archived_at, deleted_at, payload_json
        ) VALUES (
          (${beta.threadId}), 'project:client-reads', '   ', 'codex', 'full-access',
          'default', NULL, ${createdAt}, ${createdAt}, NULL, NULL, '{}'
        )
      `;

      const missing = ParticipantId.make("agent:client-reads:missing");
      const missingThread = ThreadId.make("thread:client-reads:missing");
      const homes = yield* reads.threadHomes([
        beta.threadId,
        ThreadId.make("thread:client-reads:duplicate-history:second"),
        missingThread,
        alpha.threadId,
        beta.threadId,
      ]);
      assert.deepStrictEqual(homes, [
        {
          threadId: beta.threadId,
          home: { kind: "known", squadron: { id: betaSquadron, name: "Beta Squadron" } },
        },
        {
          threadId: ThreadId.make("thread:client-reads:duplicate-history:second"),
          home: { kind: "known", squadron: { id: betaSquadron, name: "Beta Squadron" } },
        },
        { threadId: missingThread, home: { kind: "unknown" } },
        {
          threadId: alpha.threadId,
          home: { kind: "known", squadron: { id: alphaSquadron, name: "Alpha Squadron" } },
        },
      ]);

      const identities = yield* reads.participantIdentities({
        participantIds: [beta.id, duplicateHistory, missing, alpha.id, beta.id],
      });
      assert.deepStrictEqual(identities, {
        entries: [
          { participantId: beta.id, identity: { kind: "unknown" } },
          {
            participantId: duplicateHistory,
            identity: { kind: "known", displayName: "Earlier Duplicate Thread" },
          },
          { participantId: missing, identity: { kind: "unknown" } },
          { participantId: alpha.id, identity: { kind: "known", displayName: "Alpha Thread" } },
        ],
      });
      assert.deepStrictEqual(yield* reads.participantIdentities({ participantIds: [] }), {
        entries: [],
      });
    }).pipe(Effect.provide(makeTestLayer())),
);

it.effect(
  "counts exactly the A4 open list for explicit people and uses the literal open partial index",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* runJ5A2AMigrations();
      const inbox = yield* A2AHumanInbox;
      const reads = yield* ClientReadsService;
      const sql = yield* SqlClient.SqlClient;
      const squadronId = SquadronId.make("squadron:client-reads:count");
      const createdAt = "2026-08-29T00:00:00.000Z";
      yield* sql`
        INSERT INTO j5_a2a_squadron (id, name, created_at)
        VALUES (${squadronId}, 'Count Squadron', ${createdAt})
      `;
      yield* sql`
        INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at)
        VALUES (${firstPerson}, 1, ${createdAt}), (${secondPerson}, 0, ${createdAt})
      `;
      const insertExchange = Effect.fn("test.j5.a2a.clientReads.exchange")(function* (input: {
        readonly id: string;
        readonly personId: ParticipantId;
        readonly inboxStatus: "open" | "answered";
        readonly exchangeStatus: "open" | "closed";
      }) {
        const exchangeId = `exchange:client-reads:${input.id}`;
        const messageId = `message:client-reads:${input.id}`;
        const senderId = `agent:client-reads:sender:${input.id}`;
        yield* sql`
          INSERT INTO j5_a2a_exchange (
            squadron_id, exchange_id, sender_id, receiver_id, status, intent, urgency,
            opened_seq, closed_seq, created_at, updated_at
          ) VALUES (
            ${squadronId}, ${exchangeId}, ${senderId}, ${input.personId},
            ${input.exchangeStatus}, 'Count fixture', 'soon', 1,
            ${input.exchangeStatus === "closed" ? 2 : null}, ${createdAt}, ${createdAt}
          )
        `;
        yield* sql`
          INSERT INTO j5_a2a_human_inbox (
            person_id, squadron_id, exchange_id, sender_id, intent, urgency,
            latest_message_id, latest_message, opened_seq, opened_at, status,
            terminal_seq, terminal_at, terminal_disposition, terminal_cause,
            terminal_facts, terminal_notice_message_id
          ) VALUES (
            ${input.personId}, ${squadronId}, ${exchangeId}, ${senderId},
            'Count fixture', 'soon', ${messageId}, 'Count fixture',
            1, ${createdAt}, ${input.inboxStatus},
            ${input.inboxStatus === "open" ? null : 2},
            ${input.inboxStatus === "open" ? null : createdAt},
            ${input.inboxStatus === "open" ? null : "answered"}, NULL, NULL, NULL
          )
        `;
      });
      yield* insertExchange({
        id: "first-open-one",
        personId: firstPerson,
        inboxStatus: "open",
        exchangeStatus: "open",
      });
      yield* insertExchange({
        id: "first-open-two",
        personId: firstPerson,
        inboxStatus: "open",
        exchangeStatus: "open",
      });
      yield* insertExchange({
        id: "first-answered",
        personId: firstPerson,
        inboxStatus: "answered",
        exchangeStatus: "open",
      });
      yield* insertExchange({
        id: "first-closed-exchange",
        personId: firstPerson,
        inboxStatus: "open",
        exchangeStatus: "closed",
      });
      yield* insertExchange({
        id: "second-open",
        personId: secondPerson,
        inboxStatus: "open",
        exchangeStatus: "open",
      });
      const firstList = yield* inbox.list(firstPerson);
      const firstCount = yield* reads.openInboxCount(firstPerson);
      assert.equal(firstCount.personId, firstPerson);
      assert.equal(firstCount.count, firstList.length);
      assert.equal(firstCount.count, 2);
      const secondCount = yield* reads.openInboxCount(secondPerson);
      assert.deepStrictEqual(secondCount, { personId: secondPerson, count: 1 });
      assert.deepStrictEqual(yield* reads.openInboxCount(), { personId: firstPerson, count: 2 });

      const plan = yield* explainOpenInboxCountStatement(sql, firstPerson);
      assert.isTrue(
        plan.some((row) => row.detail.includes("j5_a2a_human_inbox_open_person_idx")),
        "the literal open-count predicate should use the partial person index",
      );
    }).pipe(Effect.provide(makeTestLayer())),
);
