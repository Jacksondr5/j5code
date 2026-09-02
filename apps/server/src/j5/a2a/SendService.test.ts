import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { A2ASendService, layer as sendLayer } from "./SendService.ts";
import {
  AgentParticipant,
  CommCommandId,
  ExchangeId,
  SquadronId,
  ParticipantId,
} from "./contracts.ts";

const timestamp = "2026-08-16T12:00:00.000Z";

const database = NodeSqliteClient.layerMemory();
const ledger = ledgerLayer.pipe(Layer.provide(database));
const send = sendLayer.pipe(Layer.provide(ledger), Layer.provide(database));
const testLayer = Layer.mergeAll(database, ledger, send);
const encodeAgentParticipantPayload = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ participant: AgentParticipant })),
);

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
const person = {
  kind: "human" as const,
  id: ParticipantId.make("human:send-person"),
};

const registerPerson = Effect.fn("test.j5.a2a.registerPerson")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at)
    VALUES (${person.id}, 1, ${timestamp})
  `;
});

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

it.effect("refuses a second reply when an accepted reply exists on an open exchange", () =>
  Effect.gen(function* () {
    yield* setupSameSquadron();
    const service = yield* A2ASendService;
    const sql = yield* SqlClient.SqlClient;
    const opened = yield* service.send({
      commandId: CommCommandId.make("command:already-answered:open"),
      senderThreadId: sender.threadId,
      to: receiver.id,
      message: "Can you answer once?",
      expectReply: true,
      intent: "Exercise the one-reply guard",
      acceptedAt: timestamp,
    });
    yield* service.send({
      commandId: CommCommandId.make("command:already-answered:first-reply"),
      senderThreadId: receiver.threadId,
      to: sender.id,
      message: "This is the accepted reply.",
      exchangeId: opened.exchangeId!,
      acceptedAt: timestamp,
    });

    // Reconstruct the defensive state: the reply is durable while the exchange projection is open.
    yield* sql`
      UPDATE j5_a2a_exchange
      SET status = 'open', closed_seq = NULL
      WHERE exchange_id = ${opened.exchangeId!}
    `;

    const error = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:already-answered:second-reply"),
        senderThreadId: receiver.threadId,
        to: sender.id,
        message: "This duplicate must be refused.",
        exchangeId: opened.exchangeId!,
        acceptedAt: timestamp,
      }),
    );
    assert.equal(error._tag, "A2AExchangeAlreadyAnsweredError");

    const replies = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM j5_a2a_delivery
      WHERE exchange_id = ${opened.exchangeId!}
        AND exchange_role = 'reply'
    `;
    assert.deepStrictEqual(replies, [{ count: 1 }]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses a reply whose exchange cannot record a same-squadron closure fact", () =>
  Effect.gen(function* () {
    yield* setupSameSquadron();
    const service = yield* A2ASendService;
    const ledgerService = yield* A2ALedger;
    const sql = yield* SqlClient.SqlClient;
    const opened = yield* service.send({
      commandId: CommCommandId.make("command:cross-squadron-guard:open"),
      senderThreadId: sender.threadId,
      to: receiver.id,
      message: "Can this exchange close durably?",
      expectReply: true,
      intent: "Exercise the closure invariant",
      acceptedAt: timestamp,
    });
    const foreignSquadronId = SquadronId.make("squadron:cross-squadron-guard");
    yield* ledgerService.createSquadron({
      squadron: {
        id: foreignSquadronId,
        name: "Cross-squadron guard fixture",
        createdAt: timestamp,
      },
    });
    yield* sql`
      UPDATE j5_a2a_exchange
      SET squadron_id = ${foreignSquadronId}
      WHERE exchange_id = ${opened.exchangeId}
    `;

    const error = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:cross-squadron-guard:reply"),
        senderThreadId: receiver.threadId,
        to: sender.id,
        message: "This reply must not claim closure.",
        exchangeId: opened.exchangeId!,
        acceptedAt: timestamp,
      }),
    );

    assert.equal(error._tag, "A2ACrossSquadronReplyInvariantError");
    if (error._tag === "A2ACrossSquadronReplyInvariantError") {
      assert.equal(error.exchangeId, opened.exchangeId);
      assert.equal(error.exchangeSquadronId, foreignSquadronId);
      assert.isFalse(error.replyPersisted);
      assert.include(error.message, "cannot record the required closure fact");
      assert.include(error.message, "nothing was sent");
      assert.include(error.message, "Report this invariant failure");
      assert.include(error.message, "do not retry send_message for this exchange");
      assert.notInclude(error.message, "already persisted");
      assert.notInclude(error.message, "repair the exchange/home projection");
    }
    const replies = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM j5_a2a_delivery
      WHERE exchange_id = ${opened.exchangeId}
        AND exchange_role = 'reply'
    `;
    assert.deepStrictEqual(replies, [{ count: 0 }]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("reports a persisted cross-squadron reply truthfully on command replay", () =>
  Effect.gen(function* () {
    const senderSquadronId = yield* setupSameSquadron();
    const service = yield* A2ASendService;
    const ledgerService = yield* A2ALedger;
    const sql = yield* SqlClient.SqlClient;
    const opened = yield* service.send({
      commandId: CommCommandId.make("command:cross-squadron-replay:open"),
      senderThreadId: sender.threadId,
      to: receiver.id,
      message: "Can this reply be replayed truthfully?",
      expectReply: true,
      intent: "Exercise persisted cross-squadron replay wording",
      acceptedAt: timestamp,
    });
    const replyInput = {
      commandId: CommCommandId.make("command:cross-squadron-replay:reply"),
      senderThreadId: receiver.threadId,
      to: sender.id,
      message: "This reply is already durable.",
      exchangeId: opened.exchangeId!,
      acceptedAt: timestamp,
    } as const;
    yield* service.send(replyInput);

    const exchangeSquadronId = SquadronId.make("squadron:cross-squadron-replay:foreign");
    yield* ledgerService.createSquadron({
      squadron: {
        id: exchangeSquadronId,
        name: "Cross-squadron replay fixture",
        createdAt: timestamp,
      },
    });
    yield* sql`
      UPDATE j5_a2a_exchange
      SET squadron_id = ${exchangeSquadronId}
      WHERE exchange_id = ${opened.exchangeId}
    `;
    const before = yield* sql<{
      readonly reply_deliveries: number;
      readonly command_events: number;
    }>`
      SELECT
        (
          SELECT COUNT(*)
          FROM j5_a2a_delivery
          WHERE exchange_id = ${opened.exchangeId}
            AND exchange_role = 'reply'
        ) AS reply_deliveries,
        (
          SELECT COUNT(*)
          FROM j5_a2a_comm_event
          WHERE command_id = ${replyInput.commandId}
        ) AS command_events
    `;

    const error = yield* Effect.flip(service.send(replyInput));
    assert.equal(error._tag, "A2ACrossSquadronReplyInvariantError");
    if (error._tag === "A2ACrossSquadronReplyInvariantError") {
      assert.equal(error.exchangeId, opened.exchangeId);
      assert.equal(error.exchangeSquadronId, exchangeSquadronId);
      assert.equal(error.senderSquadronId, senderSquadronId);
      assert.isTrue(error.replyPersisted);
      assert.include(error.message, "A durable reply is already persisted");
      assert.include(error.message, "this replay sent nothing new");
      assert.include(error.message, "Report this invariant failure");
      assert.include(error.message, "do not retry send_message for this exchange");
      assert.notInclude(error.message, "so nothing was sent");
    }
    const after = yield* sql<{
      readonly reply_deliveries: number;
      readonly command_events: number;
    }>`
      SELECT
        (
          SELECT COUNT(*)
          FROM j5_a2a_delivery
          WHERE exchange_id = ${opened.exchangeId}
            AND exchange_role = 'reply'
        ) AS reply_deliveries,
        (
          SELECT COUNT(*)
          FROM j5_a2a_comm_event
          WHERE command_id = ${replyInput.commandId}
        ) AS command_events
    `;
    assert.deepStrictEqual(before, [{ reply_deliveries: 1, command_events: 2 }]);
    assert.deepStrictEqual(after, before);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("validates intent and human-only urgency at exchange open", () =>
  Effect.gen(function* () {
    yield* setupSameSquadron();
    const service = yield* A2ASendService;
    yield* registerPerson();

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
        to: person.id,
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
        to: person.id,
        message: "One-shot human message",
        urgency: "fyi",
        acceptedAt: timestamp,
      }),
    );
    assert.equal(oneShotUrgency._tag, "A2AHumanAskOrReplyRequiredError");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses plain human sends while allowing human asks and replies", () =>
  Effect.gen(function* () {
    const squadronId = yield* setupSameSquadron();
    yield* registerPerson();
    const service = yield* A2ASendService;
    const ledgerService = yield* A2ALedger;
    const sql = yield* SqlClient.SqlClient;

    const plainSend = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:human-plain-send"),
        senderThreadId: sender.threadId,
        to: person.id,
        message: "This must not become ghost traffic.",
        acceptedAt: timestamp,
      }),
    );
    assert.equal(plainSend._tag, "A2AHumanAskOrReplyRequiredError");
    assert.equal(
      plainSend.message,
      `A plain send to human participant ${person.id} is refused. To the human, use an ask with expect_reply=true, intent, and urgency=blocking|soon|fyi, or a reply with exchange_id. If nobody needs to act, say it in your own thread instead.`,
    );
    const rejectedWrites = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM j5_a2a_comm_event
      WHERE command_id = 'command:human-plain-send'
    `;
    assert.deepStrictEqual(rejectedWrites, [{ count: 0 }]);

    const ask = yield* service.send({
      commandId: CommCommandId.make("command:human-ask"),
      senderThreadId: sender.threadId,
      to: person.id,
      message: "Please decide this visible question.",
      expectReply: true,
      intent: "Obtain a decision",
      urgency: "soon",
      acceptedAt: timestamp,
    });
    assert.equal(ask.exchangeState, "open");

    const explicitFollowup = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:human-explicit-followup"),
        senderThreadId: sender.threadId,
        to: person.id,
        message: "This must not follow up on the human ask.",
        exchangeId: ask.exchangeId!,
        acceptedAt: timestamp,
      }),
    );
    assert.equal(explicitFollowup._tag, "A2AHumanFollowupNotAllowedError");

    const implicitFollowup = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:human-implicit-followup"),
        senderThreadId: sender.threadId,
        to: person.id,
        message: "This also must not follow up on the human ask.",
        expectReply: true,
        acceptedAt: timestamp,
      }),
    );
    assert.equal(implicitFollowup._tag, "A2AHumanFollowupNotAllowedError");
    assert.equal(
      implicitFollowup.message,
      `A follow-up to human participant ${person.id} is refused. To the human, use an ask with expect_reply=true, intent, and urgency=blocking|soon|fyi, or a reply with exchange_id; after an ask is open, wait for its reply. If nobody needs to act, say it in your own thread instead.`,
    );
    const followupWrites = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM j5_a2a_comm_event
      WHERE command_id IN ('command:human-explicit-followup', 'command:human-implicit-followup')
    `;
    assert.deepStrictEqual(followupWrites, [{ count: 0 }]);

    const inboundExchangeId = ExchangeId.make("exchange:human-inbound");
    yield* ledgerService.append({
      commandId: CommCommandId.make("command:human-inbound"),
      squadronId,
      acceptedAt: timestamp,
      event: {
        kind: "exchange.opened",
        sender: person.id,
        receiver: sender.id,
        exchangeId: inboundExchangeId,
        correlationId: null,
        payload: { intent: "Request a reply", urgency: "soon" },
        createdAt: timestamp,
      },
    });
    const reply = yield* service.send({
      commandId: CommCommandId.make("command:human-reply"),
      senderThreadId: sender.threadId,
      to: person.id,
      message: "Here is the requested reply.",
      exchangeId: inboundExchangeId,
      acceptedAt: timestamp,
    });
    assert.equal(reply.exchangeState, "closed");
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

it.effect("fails closed when an extra active membership accompanies the correct home", () =>
  Effect.gen(function* () {
    const homeSquadronId = yield* setupSameSquadron();
    const service = yield* A2ASendService;
    const ledgerService = yield* A2ALedger;
    const sql = yield* SqlClient.SqlClient;
    const extraSquadronId = SquadronId.make("squadron:additive-projection-corruption");
    yield* ledgerService.createSquadron({
      squadron: {
        id: extraSquadronId,
        name: "Additive projection corruption",
        createdAt: timestamp,
      },
    });
    yield* sql`
      INSERT INTO j5_a2a_squadron_membership (
        squadron_id,
        participant_id,
        participant_kind,
        thread_id,
        joined_seq,
        updated_seq,
        payload
      )
      SELECT
        ${extraSquadronId},
        participant_id,
        participant_kind,
        thread_id,
        joined_seq,
        updated_seq,
        payload
      FROM j5_a2a_squadron_membership
      WHERE squadron_id = ${homeSquadronId}
        AND participant_id = ${sender.id}
    `;

    const error = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:additive-projection-corruption"),
        senderThreadId: sender.threadId,
        to: receiver.id,
        message: "This sender has a conflicting extra active membership.",
        acceptedAt: timestamp,
      }),
    );

    assert.equal(error._tag, "A2AHomeMembershipStateError");
    if (error._tag === "A2AHomeMembershipStateError") {
      assert.deepStrictEqual([...error.activeHomes].sort(), [
        `${extraSquadronId}:${sender.id}`,
        `${homeSquadronId}:${sender.id}`,
      ]);
    }
  }).pipe(Effect.provide(testLayer)),
);

it.effect("reports a legitimately retired sender without prescribing projection repair", () =>
  Effect.gen(function* () {
    const squadronId = yield* setupSameSquadron();
    const service = yield* A2ASendService;
    const ledgerService = yield* A2ALedger;
    yield* ledgerService.append({
      commandId: CommCommandId.make("command:sender:retired"),
      squadronId,
      acceptedAt: timestamp,
      event: {
        kind: "participant.left",
        sender: sender.id,
        receiver: null,
        exchangeId: null,
        correlationId: null,
        payload: { participant: sender },
        createdAt: timestamp,
      },
    });

    const error = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:sender:retired:send"),
        senderThreadId: sender.threadId,
        to: receiver.id,
        message: "This retired sender must not send.",
        acceptedAt: timestamp,
      }),
    );

    assert.equal(error._tag, "A2ASenderRetiredError");
    if (error._tag === "A2ASenderRetiredError") {
      assert.equal(error.threadId, sender.threadId);
      assert.equal(error.squadronId, squadronId);
      assert.equal(error.participantId, sender.id);
      assert.include(error.message, "retired from immutable home");
      assert.include(error.message, "participant.left");
      assert.include(error.message, "cannot send cross-agent messages");
      assert.include(error.message, "Do not repair the projection");
      assert.include(error.message, "stop this messaging attempt");
      assert.notInclude(error.message, "no registered home squadron");
    }
    assert.deepStrictEqual(yield* ledgerService.listMembership(squadronId), [
      {
        squadronId,
        participant: receiver,
        joinedSeq: 2,
        updatedSeq: 2,
      },
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("ignores left events that do not identify a later retirement of the exact home", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const service = yield* A2ASendService;
    const ledgerService = yield* A2ALedger;
    const sql = yield* SqlClient.SqlClient;
    const homeSquadronId = SquadronId.make("squadron:retirement-decoys:home");
    const foreignSquadronId = SquadronId.make("squadron:retirement-decoys:foreign");
    yield* ledgerService.createSquadron({
      squadron: { id: homeSquadronId, name: "Retirement decoy home", createdAt: timestamp },
    });
    yield* ledgerService.createSquadron({
      squadron: {
        id: foreignSquadronId,
        name: "Retirement decoy foreign",
        createdAt: timestamp,
      },
    });
    const appendAgentEvent = (
      squadronId: SquadronId,
      commandId: string,
      kind: "participant.joined" | "participant.left",
      participant: AgentParticipant,
    ) =>
      ledgerService.append({
        commandId: CommCommandId.make(commandId),
        squadronId,
        acceptedAt: timestamp,
        event: {
          kind,
          sender: kind === "participant.left" ? participant.id : null,
          receiver: kind === "participant.joined" ? participant.id : null,
          exchangeId: null,
          correlationId: null,
          payload: { participant },
          createdAt: timestamp,
        },
      });

    yield* appendAgentEvent(
      homeSquadronId,
      "command:retirement-decoys:pre-join-left",
      "participant.left",
      sender,
    );
    yield* appendAgentEvent(
      homeSquadronId,
      "command:retirement-decoys:sender-join",
      "participant.joined",
      sender,
    );
    yield* appendAgentEvent(
      homeSquadronId,
      "command:retirement-decoys:receiver-join",
      "participant.joined",
      receiver,
    );
    for (const index of [1, 2]) {
      yield* appendAgentEvent(
        foreignSquadronId,
        `command:retirement-decoys:foreign-padding:${index}`,
        "participant.joined",
        {
          kind: "agent",
          id: ParticipantId.make(`agent:retirement-padding:${index}`),
          threadId: ThreadId.make(`thread:retirement-padding:${index}`),
        },
      );
    }
    yield* appendAgentEvent(
      foreignSquadronId,
      "command:retirement-decoys:foreign-left",
      "participant.left",
      sender,
    );
    yield* appendAgentEvent(
      homeSquadronId,
      "command:retirement-decoys:wrong-participant-left",
      "participant.left",
      {
        kind: "agent",
        id: ParticipantId.make("agent:retirement-decoy"),
        threadId: sender.threadId,
      },
    );
    const wrongThreadParticipant: AgentParticipant = {
      kind: "agent",
      id: sender.id,
      threadId: ThreadId.make("thread:retirement-decoy"),
    };
    const wrongThreadPayload = yield* encodeAgentParticipantPayload({
      participant: wrongThreadParticipant,
    });
    const sequenceRows = yield* sql<{ readonly next_seq: number }>`
      SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
      FROM j5_a2a_comm_event
      WHERE squadron_id = ${homeSquadronId}
    `;
    const decoySeq = sequenceRows[0]!.next_seq;
    yield* sql`
      INSERT INTO j5_a2a_comm_event (
        seq,
        squadron_id,
        kind,
        sender,
        receiver,
        exchange_id,
        correlation_id,
        payload,
        created_at,
        command_id
      ) VALUES (
        ${decoySeq},
        ${homeSquadronId},
        'participant.left',
        ${wrongThreadParticipant.id},
        NULL,
        NULL,
        NULL,
        ${wrongThreadPayload},
        ${timestamp},
        'command:retirement-decoys:wrong-thread-left'
      )
    `;

    const result = yield* service.send({
      commandId: CommCommandId.make("command:retirement-decoys:send"),
      senderThreadId: sender.threadId,
      to: receiver.id,
      message: "These unrelated left events must not retire the live sender.",
      acceptedAt: timestamp,
    });

    assert.equal(result.exchangeState, "none");
    assert.equal(result.durableAtSeq, decoySeq + 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("lists member agents and registry-derived person capabilities", () =>
  Effect.gen(function* () {
    yield* setupSameSquadron();
    yield* registerPerson();
    const secondPersonId = ParticipantId.make("human:send-person-two");
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at)
      VALUES (${secondPersonId}, 0, ${timestamp})
    `;
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
          id: person.id,
          canReceiveMessage: false,
          canOpenExchange: true,
          acceptsUrgency: true,
        },
        {
          id: secondPersonId,
          canReceiveMessage: false,
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
