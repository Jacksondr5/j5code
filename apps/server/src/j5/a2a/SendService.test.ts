import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { A2ASendService, layer as sendLayer } from "./SendService.ts";
import { CommCommandId, SquadronId, ParticipantId, type AgentParticipant } from "./contracts.ts";

const timestamp = "2026-08-16T12:00:00.000Z";

const database = NodeSqliteClient.layerMemory();
const ledger = ledgerLayer.pipe(Layer.provide(database));
const send = sendLayer.pipe(Layer.provide(ledger), Layer.provide(database));
const testLayer = Layer.mergeAll(database, ledger, send);

const sender: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:sender"),
  threadId: ThreadId.make("thread:sender"),
};
const receiver: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:receiver"),
  threadId: ThreadId.make("thread:receiver"),
};

const setupSameSquadron = Effect.fn("test.j5.a2a.setupSameSquadron")(function* () {
  yield* runJ5A2AMigrations();
  const ledgerService = yield* A2ALedger;
  const squadronId = SquadronId.make("squadron:exchange");
  yield* ledgerService.createSquadron({
    squadron: { id: squadronId, name: "Exchange", createdAt: timestamp },
  });
  for (const [index, participant] of [sender, receiver].entries()) {
    yield* ledgerService.append({
      commandId: CommCommandId.make(`command:join:${index}`),
      squadronId,
      acceptedAt: timestamp,
      event: {
        kind: "participant.joined",
        sender: null,
        receiver: participant.id,
        exchangeId: null,
        correlationId: null,
        payload: { participant },
        createdAt: timestamp,
      },
    });
  }
  return squadronId;
});

it.effect("opens once per sender-receiver pair, joins follow-ups, and one reply closes", () =>
  Effect.gen(function* () {
    const squadronId = yield* setupSameSquadron();
    const service = yield* A2ASendService;
    const sql = yield* SqlClient.SqlClient;

    const first = yield* service.send({
      commandId: CommCommandId.make("command:exchange:first"),
      senderThreadId: sender.threadId,
      to: receiver.id,
      message: "Can you verify delivery?",
      expectReply: true,
      intent: "Verify the delivery path",
      acceptedAt: timestamp,
    });
    const followup = yield* service.send({
      commandId: CommCommandId.make("command:exchange:followup"),
      senderThreadId: sender.threadId,
      to: receiver.id,
      message: "Please include the crash window.",
      expectReply: true,
      acceptedAt: timestamp,
    });
    assert.equal(followup.exchangeId, first.exchangeId);
    assert.isTrue(followup.joinedExistingExchange);

    const reply = yield* service.send({
      commandId: CommCommandId.make("command:exchange:reply"),
      senderThreadId: receiver.threadId,
      to: sender.id,
      message: "Verified.",
      exchangeId: first.exchangeId!,
      acceptedAt: timestamp,
    });
    assert.equal(reply.exchangeState, "closed");
    assert.deepStrictEqual(
      yield* service.send({
        commandId: CommCommandId.make("command:exchange:reply"),
        senderThreadId: receiver.threadId,
        to: sender.id,
        message: "Verified.",
        exchangeId: first.exchangeId!,
        acceptedAt: timestamp,
      }),
      reply,
      "the same-squadron reply command replays its original durable sequence",
    );
    assert.deepStrictEqual(
      yield* service.send({
        commandId: CommCommandId.make("command:exchange:first"),
        senderThreadId: sender.threadId,
        to: receiver.id,
        message: "Can you verify delivery?",
        expectReply: true,
        intent: "Verify the delivery path",
        acceptedAt: timestamp,
      }),
      first,
      "the opening command replays its original result after closure",
    );
    assert.deepStrictEqual(
      yield* service.send({
        commandId: CommCommandId.make("command:exchange:followup"),
        senderThreadId: sender.threadId,
        to: receiver.id,
        message: "Please include the crash window.",
        expectReply: true,
        acceptedAt: timestamp,
      }),
      followup,
      "the follow-up command replays its original result after closure",
    );

    const rows = yield* sql<{ readonly kind: string; readonly count: number }>`
      SELECT kind, COUNT(*) AS count
      FROM j5_a2a_comm_event
      WHERE squadron_id = ${squadronId}
        AND kind IN ('exchange.opened', 'message.sent', 'exchange.closed')
      GROUP BY kind
      ORDER BY kind
    `;
    assert.deepStrictEqual(rows, [
      { kind: "exchange.closed", count: 1 },
      { kind: "exchange.opened", count: 1 },
      { kind: "message.sent", count: 3 },
    ]);

    const closedError = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:exchange:second-reply"),
        senderThreadId: receiver.threadId,
        to: sender.id,
        message: "A duplicate reply.",
        exchangeId: first.exchangeId!,
        acceptedAt: timestamp,
      }),
    );
    assert.equal(closedError._tag, "A2AExchangeNotOpenError");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("validates intent and human-only urgency at exchange open", () =>
  Effect.gen(function* () {
    const squadronId = yield* setupSameSquadron();
    const ledgerService = yield* A2ALedger;
    const service = yield* A2ASendService;
    yield* ledgerService.append({
      commandId: CommCommandId.make("command:join:human"),
      squadronId,
      acceptedAt: timestamp,
      event: {
        kind: "participant.joined",
        sender: null,
        receiver: ParticipantId.make("human:global"),
        exchangeId: null,
        correlationId: null,
        payload: { participant: { kind: "human" } },
        createdAt: timestamp,
      },
    });

    const missingIntent = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:missing-intent"),
        senderThreadId: sender.threadId,
        to: receiver.id,
        message: "Question",
        expectReply: true,
        acceptedAt: timestamp,
      }),
    );
    assert.equal(missingIntent._tag, "A2AIntentRequiredError");

    const missingUrgency = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:missing-urgency"),
        senderThreadId: sender.threadId,
        to: ParticipantId.make("human:global"),
        message: "Human question",
        expectReply: true,
        intent: "Obtain a human ruling",
        acceptedAt: timestamp,
      }),
    );
    assert.equal(missingUrgency._tag, "A2AUrgencyRequiredError");

    const wrongUrgency = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:wrong-urgency"),
        senderThreadId: sender.threadId,
        to: receiver.id,
        message: "Agent question",
        expectReply: true,
        intent: "Ask an agent",
        urgency: "soon",
        acceptedAt: timestamp,
      }),
    );
    assert.equal(wrongUrgency._tag, "A2AUrgencyNotAcceptedError");

    const oneShotUrgency = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:one-shot-urgency"),
        senderThreadId: sender.threadId,
        to: ParticipantId.make("human:global"),
        message: "One-shot human message",
        urgency: "fyi",
        acceptedAt: timestamp,
      }),
    );
    assert.equal(oneShotUrgency._tag, "A2AUrgencyRequiresExchangeError");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rolls back the send receipt when its projection write fails", () =>
  Effect.gen(function* () {
    yield* setupSameSquadron();
    const service = yield* A2ASendService;
    const sql = yield* SqlClient.SqlClient;
    const command = CommCommandId.make("command:receipt-rollback");
    yield* sql`
      CREATE TRIGGER j5_a2a_test_fail_exchange_projection
      BEFORE INSERT ON j5_a2a_exchange
      WHEN NEW.exchange_id LIKE 'exchange:j5:a2a:%'
      BEGIN
        SELECT RAISE(ABORT, 'forced projection failure');
      END
    `;

    yield* Effect.flip(
      service.send({
        commandId: command,
        senderThreadId: sender.threadId,
        to: receiver.id,
        message: "This transaction must roll back.",
        expectReply: true,
        intent: "Prove receipt rollback",
        acceptedAt: timestamp,
      }),
    );
    const poisoned = yield* sql<{ readonly receipts: number; readonly events: number }>`
      SELECT
        (SELECT COUNT(*) FROM j5_a2a_comm_command_receipt WHERE command_id = ${command}) AS receipts,
        (SELECT COUNT(*) FROM j5_a2a_comm_event WHERE command_id = ${command}) AS events
    `;
    assert.deepStrictEqual(poisoned, [{ receipts: 0, events: 0 }]);

    yield* sql`DROP TRIGGER j5_a2a_test_fail_exchange_projection`;
    const retry = yield* service.send({
      commandId: command,
      senderThreadId: sender.threadId,
      to: receiver.id,
      message: "This transaction must roll back.",
      expectReply: true,
      intent: "Prove receipt rollback",
      acceptedAt: timestamp,
    });
    assert.equal(retry.exchangeState, "open");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("fails closed when a native thread has no provisioned squadron membership", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const service = yield* A2ASendService;
    const sql = yield* SqlClient.SqlClient;
    const nativeThreadId = ThreadId.make("thread:native-without-home-squadron");

    const listError = yield* Effect.flip(service.listParticipants(nativeThreadId));
    assert.equal(listError._tag, "A2ASenderNotJoinedError");
    assert.include(listError.message, "native thread");
    assert.include(listError.message, "no registered home squadron");
    assert.include(listError.message, "No native user-created-thread hook");
    assert.include(listError.message, "internal registrar");
    assert.include(listError.message, "A6 creation wrapper");
    assert.include(listError.message, "controlled tests may seed membership directly");
    assert.include(listError.message, "Stop this messaging attempt");
    assert.notMatch(listError.message, /ask the user|product workflow|list_participants again/i);

    const sendError = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:native-without-home-squadron"),
        senderThreadId: nativeThreadId,
        to: receiver.id,
        message: "This must fail without provisioning.",
        acceptedAt: timestamp,
      }),
    );
    assert.equal(sendError._tag, "A2ASenderNotJoinedError");

    const state = yield* sql<{ readonly squadrons: number; readonly events: number }>`
      SELECT
        (SELECT COUNT(*) FROM j5_a2a_squadron) AS squadrons,
        (SELECT COUNT(*) FROM j5_a2a_comm_event) AS events
    `;
    assert.deepStrictEqual(state, [{ squadrons: 0, events: 0 }]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("fails loudly when active membership diverges from the immutable home", () =>
  Effect.gen(function* () {
    const homeSquadronId = yield* setupSameSquadron();
    const service = yield* A2ASendService;
    const ledgerService = yield* A2ALedger;
    const sql = yield* SqlClient.SqlClient;
    const corruptedSquadronId = SquadronId.make("squadron:corrupted-projection");
    yield* ledgerService.createSquadron({
      squadron: {
        id: corruptedSquadronId,
        name: "Corrupted projection",
        createdAt: timestamp,
      },
    });
    yield* sql`
      UPDATE j5_a2a_squadron_membership
      SET squadron_id = ${corruptedSquadronId}
      WHERE squadron_id = ${homeSquadronId}
        AND participant_id = ${sender.id}
    `;

    const error = yield* Effect.flip(service.listParticipants(sender.threadId));

    assert.equal(error._tag, "A2AHomeMembershipStateError");
    if (error._tag === "A2AHomeMembershipStateError") {
      assert.equal(error.expectedSquadronId, homeSquadronId);
      assert.equal(error.expectedParticipantId, sender.id);
      assert.deepStrictEqual(error.activeHomes, [`${corruptedSquadronId}:${sender.id}`]);
      assert.include(error.message, "immutable home");
      assert.include(error.message, "Repair the projection");
      assert.include(error.message, "do not register a new home");
      assert.notInclude(error.message, "no registered home squadron");
    }
  }).pipe(Effect.provide(testLayer)),
);

it.effect("lists membership-derived participant capabilities", () =>
  Effect.gen(function* () {
    const squadronId = yield* setupSameSquadron();
    yield* (yield* A2ALedger).append({
      commandId: CommCommandId.make("command:list:join:human"),
      squadronId,
      acceptedAt: timestamp,
      event: {
        kind: "participant.joined",
        sender: null,
        receiver: ParticipantId.make("human:global"),
        exchangeId: null,
        correlationId: null,
        payload: { participant: { kind: "human" } },
        createdAt: timestamp,
      },
    });
    const rows = yield* (yield* A2ASendService).listParticipants(sender.threadId);
    assert.deepStrictEqual(
      rows.map((row) => ({
        id: row.participantId,
        canReceiveMessage: row.canReceiveMessage,
        canOpenExchange: row.canOpenExchange,
        acceptsUrgency: row.acceptsUrgency,
      })),
      [
        {
          id: receiver.id,
          canReceiveMessage: true,
          canOpenExchange: true,
          acceptsUrgency: false,
        },
        {
          id: sender.id,
          canReceiveMessage: true,
          canOpenExchange: true,
          acceptsUrgency: false,
        },
        {
          id: ParticipantId.make("human:global"),
          canReceiveMessage: true,
          canOpenExchange: true,
          acceptsUrgency: true,
        },
      ],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("marks duplicate participant identities unavailable before send", () =>
  Effect.gen(function* () {
    yield* setupSameSquadron();
    const ledgerService = yield* A2ALedger;
    const duplicateSquadronId = SquadronId.make("squadron:exchange:duplicate-receiver");
    const duplicateReceiver = {
      ...receiver,
      threadId: ThreadId.make("thread:receiver:duplicate-identity"),
    };
    yield* ledgerService.createSquadron({
      squadron: { id: duplicateSquadronId, name: "Duplicate receiver", createdAt: timestamp },
    });
    yield* ledgerService.appendEvents({
      commandId: CommCommandId.make("command:join:duplicate-receiver"),
      squadronId: duplicateSquadronId,
      acceptedAt: timestamp,
      events: [
        {
          kind: "participant.joined",
          sender: null,
          receiver: receiver.id,
          exchangeId: null,
          correlationId: null,
          payload: { participant: duplicateReceiver },
          createdAt: timestamp,
        },
      ],
    });

    const service = yield* A2ASendService;
    const rows = (yield* service.listParticipants(sender.threadId)).filter(
      (row) => row.participantId === receiver.id,
    );
    assert.lengthOf(rows, 2);
    assert.isTrue(rows.every((row) => !row.canReceiveMessage && !row.canOpenExchange));

    const error = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:ambiguous-receiver"),
        senderThreadId: sender.threadId,
        to: receiver.id,
        message: "This must fail before append.",
        acceptedAt: timestamp,
      }),
    );
    assert.equal(error._tag, "A2AAmbiguousParticipantError");
    assert.include(error.message, "choose a participantId with canReceiveMessage=true");
    assert.include(error.message, "ask the human");
  }).pipe(Effect.provide(testLayer)),
);
