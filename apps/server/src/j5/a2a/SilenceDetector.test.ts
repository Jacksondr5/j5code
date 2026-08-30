import { assert, it } from "@effect/vitest";
import {
  MessageId,
  EventId,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { A2ADeliveryWorker, manualLayer as deliveryWorkerLayer } from "./DeliveryWorker.ts";
import { A2ADeliveryTransport, type A2ADeliveryTransportShape } from "./DeliveryTransport.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { A2ASendService, layer as sendLayer } from "./SendService.ts";
import {
  A2ASilenceDetector,
  SilenceNoticePayload,
  STOPPED_NOTICE_INSTRUCTION,
  layer as liveSilenceDetectorLayer,
  manualLayer as silenceDetectorLayer,
} from "./SilenceDetector.ts";
import {
  CommCommandId,
  CorrelationId,
  ExchangeId,
  LedgerMessageId,
  SquadronId,
  ParticipantId,
  SILENCE_DETECTOR_PARTICIPANT_ID,
  type AgentParticipant,
  type HumanParticipant,
} from "./contracts.ts";

const squadronId = SquadronId.make("squadron:silence-test");
const waiter: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:silence:waiter"),
  threadId: ThreadId.make("thread:silence:waiter"),
};
const subject: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:silence:subject"),
  threadId: ThreadId.make("thread:silence:subject"),
};
const peer: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:silence:peer"),
  threadId: ThreadId.make("thread:silence:peer"),
};
const newerPeer: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:silence:newer-peer"),
  threadId: ThreadId.make("thread:silence:newer-peer"),
};
const person: HumanParticipant = {
  kind: "human",
  id: ParticipantId.make("human:silence-person"),
};
const failureDetail = {
  class: "provider_error" as const,
  message: "Provider exited with the measured failure detail.",
  code: "TEST_FAILURE",
  retryable: false,
} satisfies OrchestrationV2ProviderFailure;

const iso = (second: number) => `2026-08-19T12:00:${String(second).padStart(2, "0")}.000Z`;
const decodeSilenceNotice = Schema.decodeUnknownEffect(SilenceNoticePayload);

const makeTestLayer = () => {
  const database = NodeSqliteClient.layerMemory();
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const send = sendLayer.pipe(Layer.provide(ledger), Layer.provide(database));
  const threads = Layer.mock(ThreadManagementService)({
    getThreadProjection: () =>
      Effect.succeed({
        runs: [],
        turnItems: [
          {
            runId: RunId.make("run:silence:test"),
            type: "error",
            status: "failed",
            failure: failureDetail,
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection),
  });
  const transport = Layer.succeed(
    A2ADeliveryTransport,
    A2ADeliveryTransport.of({
      deliverAgent: () => Effect.void,
      deliverHuman: () => Effect.void,
    } satisfies A2ADeliveryTransportShape),
  );
  const worker = deliveryWorkerLayer.pipe(
    Layer.provide(ledger),
    Layer.provide(database),
    Layer.provide(transport),
  );
  const detector = silenceDetectorLayer.pipe(
    Layer.provide(ledger),
    Layer.provide(database),
    Layer.provide(threads),
    Layer.provideMerge(worker),
  );
  return Layer.mergeAll(database, ledger, send, detector);
};

const makeDaemonTestLayer = (
  storedEvents: (input?: {
    readonly afterSequence?: number;
  }) => Stream.Stream<OrchestrationV2StoredEvent>,
  runs: ReadonlyArray<OrchestrationV2Run>,
  initialHighWater: number,
) => {
  const database = SqlitePersistenceMemory.pipe(
    Layer.tap((context) => {
      const sql = Context.get(context, SqlClient.SqlClient);
      return sql`
        INSERT OR IGNORE INTO orchestration_v2_events (
            sequence,
            event_id,
            command_id,
            thread_id,
            run_id,
            node_id,
            provider,
            raw_event_id,
            event_type,
            occurred_at,
            payload_json
          ) VALUES (
            ${initialHighWater},
            'event:silence:cursor-high-water',
            NULL,
            'thread:silence:cursor-high-water',
            NULL,
            NULL,
            NULL,
            NULL,
            'thread.created',
            ${iso(0)},
            '{}'
          )
        `;
    }),
  );
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const send = sendLayer.pipe(Layer.provide(ledger), Layer.provide(database));
  const threads = Layer.mock(ThreadManagementService)({
    getThreadProjection: () =>
      Effect.succeed({ runs, turnItems: [] } as unknown as OrchestrationV2ThreadProjection),
    streamStoredEventsFrom: storedEvents,
  });
  const transport = Layer.succeed(
    A2ADeliveryTransport,
    A2ADeliveryTransport.of({
      deliverAgent: () => Effect.void,
      deliverHuman: () => Effect.void,
    } satisfies A2ADeliveryTransportShape),
  );
  const worker = deliveryWorkerLayer.pipe(
    Layer.provide(ledger),
    Layer.provide(database),
    Layer.provide(transport),
  );
  const detector = liveSilenceDetectorLayer.pipe(
    Layer.provide(ledger),
    Layer.provide(database),
    Layer.provide(threads),
    Layer.provideMerge(worker),
  );
  return Layer.mergeAll(database, ledger, send, detector);
};

const join = Effect.fn("test.j5.a2a.silence.join")(function* (
  participant: AgentParticipant,
  suffix: string,
) {
  const participantId = participant.id;
  yield* (yield* A2ALedger).append({
    commandId: CommCommandId.make(`command:silence:join:${suffix}`),
    squadronId,
    acceptedAt: iso(0),
    event: {
      kind: "participant.joined",
      sender: null,
      receiver: participantId,
      exchangeId: null,
      correlationId: null,
      payload: { participant },
      createdAt: iso(0),
    },
  });
});

const seed = Effect.fn("test.j5.a2a.silence.seed")(function* () {
  yield* runJ5A2AMigrations();
  const ledger = yield* A2ALedger;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at)
    VALUES (${person.id}, 1, ${iso(0)})
  `;
  yield* ledger.createSquadron({
    squadron: { id: squadronId, name: "Silence detector", createdAt: iso(0) },
  });
  yield* join(waiter, "waiter");
  yield* join(subject, "subject");
  yield* join(peer, "peer");
  yield* join(newerPeer, "newer-peer");
});

const openExchange = Effect.fn("test.j5.a2a.silence.openExchange")(function* (
  from: AgentParticipant,
  to: ParticipantId,
  suffix: string,
  acceptedAtSecond = 0,
) {
  return yield* (yield* A2ASendService).send({
    commandId: CommCommandId.make(`command:silence:send:${suffix}`),
    senderThreadId: from.threadId,
    to,
    message: `Silence detector request ${suffix}`,
    expectReply: true,
    intent: `Prove ${suffix}`,
    ...(to === person.id ? { urgency: "blocking" as const } : {}),
    acceptedAt: iso(acceptedAtSecond),
  });
});

const markDelivered = Effect.fn("test.j5.a2a.silence.markDelivered")(function* (
  messageId: LedgerMessageId,
  exchangeId: ExchangeId,
  senderId: ParticipantId,
  receiverId: ParticipantId,
  second: number,
  channel: "agent" | "human" = "agent",
) {
  const result = yield* (yield* A2ALedger).append({
    commandId: CommCommandId.make(`command:silence:delivered:${messageId}`),
    squadronId,
    acceptedAt: iso(second),
    event: {
      kind: "message.delivered",
      sender: senderId,
      receiver: receiverId,
      exchangeId,
      correlationId: CorrelationId.make(`correlation:silence:delivered:${messageId}`),
      payload: { messageId, attempt: 1, channel },
      createdAt: iso(second),
    },
  });
  return result.event;
});

const markAlarmed = Effect.fn("test.j5.a2a.silence.markAlarmed")(function* (
  messageId: LedgerMessageId,
  exchangeId: ExchangeId,
  senderId: ParticipantId,
  receiverId: ParticipantId,
) {
  yield* (yield* A2ALedger).append({
    commandId: CommCommandId.make(`command:silence:alarmed:${messageId}`),
    squadronId,
    acceptedAt: iso(1),
    event: {
      kind: "message.delivery_failed",
      sender: senderId,
      receiver: receiverId,
      exchangeId,
      correlationId: CorrelationId.make(`correlation:silence:alarmed:${messageId}`),
      payload: {
        messageId,
        attempt: 3,
        error: "Human inbox delivery failed",
        nextAttemptAt: null,
        alarmed: true,
      },
      createdAt: iso(1),
    },
  });
});

const silenceAppendCommand = (
  exchangeId: ExchangeId,
  deliveryMessageId: LedgerMessageId,
  suffix: string,
) => {
  const observedAt = iso(6);
  const correlationId = CorrelationId.make(`correlation:silence:serialization:${suffix}`);
  return {
    commandId: CommCommandId.make(`command:silence:serialization:${suffix}`),
    squadronId,
    acceptedAt: observedAt,
    events: [
      {
        kind: "silence.notice" as const,
        sender: null,
        receiver: waiter.id,
        exchangeId,
        correlationId,
        payload: {
          subjectId: subject.id,
          deliveryMessageId,
          observedAt,
          state: "turn-ended-no-reply" as const,
          runId: null,
          processing: "never-processed" as const,
        },
        createdAt: observedAt,
      },
      {
        kind: "message.sent" as const,
        sender: SILENCE_DETECTOR_PARTICIPANT_ID,
        receiver: waiter.id,
        exchangeId: null,
        correlationId,
        payload: {
          messageId: LedgerMessageId.make(`message:silence:serialization:${suffix}`),
          text: "Serialization seam silence notice",
          originSquadronId: squadronId,
          receiverSquadronId: squadronId,
          exchangeRole: "none" as const,
          envelopeChannel: "silence_notice" as const,
        },
        createdAt: observedAt,
      },
    ],
  };
};

const dropExchange = Effect.fn("test.j5.a2a.silence.dropExchange")(function* (
  exchangeId: ExchangeId,
  suffix: string,
) {
  yield* (yield* A2ALedger).append({
    commandId: CommCommandId.make(`command:silence:serialization:drop:${suffix}`),
    squadronId,
    acceptedAt: iso(5),
    event: {
      kind: "exchange.dropped",
      sender: waiter.id,
      receiver: subject.id,
      exchangeId,
      correlationId: CorrelationId.make(`correlation:silence:serialization:drop:${suffix}`),
      payload: {
        disposition: "receiver-retired",
        cause: {
          kind: "participant-archived",
          participantId: subject.id,
          squadronId,
        },
        facts: {
          replyRequired: false,
          retryAllowed: false,
          replacementRequired: false,
        },
        noticeMessageId: LedgerMessageId.make(`message:silence:serialization:drop:${suffix}`),
      },
      createdAt: iso(5),
    },
  });
});

const terminalEvent = (
  status: "completed" | "failed" | "interrupted" | "cancelled" | "rolled_back",
  sequence = 100,
): OrchestrationV2StoredEvent => {
  const completedAt = DateTime.makeUnsafe(iso(3));
  const runId = RunId.make("run:silence:test");
  return {
    sequence,
    commandId: null,
    event: {
      id: EventId.make(`event:silence:${status}:${sequence}`),
      type: "run.updated",
      threadId: subject.threadId,
      runId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      occurredAt: completedAt,
      payload: {
        id: runId,
        threadId: subject.threadId,
        ordinal: 1,
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
        providerThreadId: null,
        userMessageId: MessageId.make("message:silence:upstream"),
        rootNodeId: null,
        activeAttemptId: null,
        status,
        requestedAt: DateTime.makeUnsafe(iso(0)),
        startedAt: DateTime.makeUnsafe(iso(1)),
        completedAt,
        checkpointId: null,
        contextHandoffId: null,
      },
    },
  };
};

const readNotices = Effect.fn("test.j5.a2a.silence.readNotices")(function* () {
  const page = yield* (yield* A2ALedger).readEvents({
    squadronId,
    cursor: { afterSeq: 0 },
    limit: 100,
  });
  return yield* Effect.forEach(
    page.events.filter((event) => event.kind === "silence.notice"),
    (event) => decodeSilenceNotice(event.payload),
  );
});

const seedInbound = Effect.fn("test.j5.a2a.silence.seedInbound")(function* (deliveredAt: number) {
  const exchange = yield* openExchange(waiter, subject.id, `inbound-${deliveredAt}`);
  assert.isNotNull(exchange.exchangeId);
  const deliveryEvent = yield* markDelivered(
    exchange.messageId,
    exchange.exchangeId!,
    waiter.id,
    subject.id,
    deliveredAt,
  );
  return { ...exchange, deliveryEvent };
});

const captureNoticeIdentity = (producer: "delivery" | "lifecycle") =>
  Effect.gen(function* () {
    yield* seed();
    const exchange = yield* seedInbound(2);
    const detector = yield* A2ASilenceDetector;
    if (producer === "delivery") {
      yield* detector.handleDeliveryEvent(exchange.deliveryEvent);
    } else {
      yield* detector.handleStoredEvent(terminalEvent("completed"));
    }

    const rows = yield* (yield* SqlClient.SqlClient)<{
      readonly command_id: string;
      readonly correlation_id: string;
      readonly message_id: string;
    }>`
      SELECT command_id, correlation_id, message_id
      FROM j5_a2a_delivery
      WHERE envelope_channel = 'silence_notice'
    `;
    assert.lengthOf(rows, 1);
    return { exchange, identity: rows[0]! };
  }).pipe(Effect.provide(makeTestLayer()));

it.effect("uses one receipt identity across delivery and lifecycle producers", () =>
  Effect.gen(function* () {
    const fromDelivery = yield* captureNoticeIdentity("delivery");
    const fromLifecycle = yield* captureNoticeIdentity("lifecycle");

    assert.deepStrictEqual(fromDelivery.identity, fromLifecycle.identity);
    const noticeIdentity = [
      squadronId,
      fromDelivery.exchange.exchangeId!,
      fromDelivery.exchange.messageId,
    ]
      .map(encodeURIComponent)
      .join(":");
    assert.deepStrictEqual(fromDelivery.identity, {
      command_id: `command:j5:a2a:silence:${noticeIdentity}`,
      correlation_id: `correlation:j5:a2a:silence:${noticeIdentity}`,
      message_id: `message:j5:a2a:silence:${noticeIdentity}`,
    });
  }),
);

it.effect("emits processed mid-turn silence and dedupes a later lifecycle sequence", () =>
  Effect.gen(function* () {
    yield* seed();
    const exchange = yield* seedInbound(2);
    const detector = yield* A2ASilenceDetector;
    yield* detector.handleStoredEvent(terminalEvent("completed"));
    yield* detector.handleStoredEvent(terminalEvent("completed", 101));

    const notices = yield* readNotices();
    assert.lengthOf(notices, 1, "a later lifecycle event must not duplicate the notice");
    assert.equal(notices[0]?.state, "turn-ended-no-reply");
    if (notices[0]?.state === "turn-ended-no-reply") {
      assert.equal(notices[0].processing, "processed");
    }
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly status: string }>`
      SELECT status FROM j5_a2a_exchange WHERE exchange_id = ${exchange.exchangeId}
    `;
    assert.deepStrictEqual(rows, [{ status: "open" }]);
    const deliveries = yield* sql<{
      readonly command_id: string;
      readonly correlation_id: string;
      readonly envelope_channel: string;
      readonly message_id: string;
      readonly message_text: string;
      readonly sender_id: string;
      readonly status: string;
    }>`
      SELECT
        command_id,
        correlation_id,
        envelope_channel,
        message_id,
        message_text,
        sender_id,
        status
      FROM j5_a2a_delivery
      WHERE envelope_channel = 'silence_notice'
    `;
    assert.lengthOf(deliveries, 1);
    const noticeDelivery = deliveries[0]!;
    assert.equal(noticeDelivery.envelope_channel, "silence_notice");
    assert.include(noticeDelivery.message_text, "platform-authored delivery signal");
    assert.notInclude(noticeDelivery.message_text, "[Cross-agent message from");
    assert.equal(noticeDelivery.sender_id, SILENCE_DETECTOR_PARTICIPANT_ID);
    assert.equal(noticeDelivery.status, "pending");
    const noticeIdentity = [squadronId, exchange.exchangeId!, exchange.messageId]
      .map(encodeURIComponent)
      .join(":");
    assert.equal(noticeDelivery.command_id, `command:j5:a2a:silence:${noticeIdentity}`);
    assert.equal(noticeDelivery.message_id, `message:j5:a2a:silence:${noticeIdentity}`);
    assert.equal(noticeDelivery.correlation_id, `correlation:j5:a2a:silence:${noticeIdentity}`);

    const milestones = yield* (yield* A2ADeliveryWorker).drain;
    assert.isTrue(
      milestones.some((milestone) => milestone.messageId === noticeDelivery.message_id),
      "the existing A2 worker must drain the typed silence-notice row",
    );
    const delivered = yield* sql<{ readonly status: string }>`
      SELECT status FROM j5_a2a_delivery WHERE message_id = ${noticeDelivery.message_id}
    `;
    assert.deepStrictEqual(delivered, [{ status: "delivered" }]);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("no-ops when A9 drops after the A3 read but before its serialized append", () =>
  Effect.gen(function* () {
    yield* seed();
    const inbound = yield* seedInbound(2);
    assert.isNotNull(inbound.exchangeId);
    const exchangeId = inbound.exchangeId!;
    const sql = yield* SqlClient.SqlClient;
    const observed = yield* sql<{ readonly status: string }>`
      SELECT status FROM j5_a2a_exchange WHERE exchange_id = ${exchangeId}
    `;
    assert.deepStrictEqual(observed, [{ status: "open" }]);

    yield* dropExchange(exchangeId, "drop-before-append");
    const attempted = yield* (yield* A2ALedger).appendEventsIfExchangeOpen(
      silenceAppendCommand(exchangeId, inbound.messageId, "drop-before-append"),
      exchangeId,
    );
    assert.isNull(attempted);

    const rows = yield* sql<{
      readonly dropped: number;
      readonly silence: number;
      readonly silence_deliveries: number;
    }>`
      SELECT
        (SELECT COUNT(*) FROM j5_a2a_comm_event WHERE kind = 'exchange.dropped' AND exchange_id = ${exchangeId}) AS dropped,
        (SELECT COUNT(*) FROM j5_a2a_comm_event WHERE kind = 'silence.notice' AND exchange_id = ${exchangeId}) AS silence,
        (SELECT COUNT(*) FROM j5_a2a_delivery WHERE envelope_channel = 'silence_notice' AND command_id = 'command:silence:serialization:drop-before-append') AS silence_deliveries
    `;
    assert.deepStrictEqual(rows, [{ dropped: 1, silence: 0, silence_deliveries: 0 }]);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("keeps both historical facts when A3 appends before A9 drops", () =>
  Effect.gen(function* () {
    yield* seed();
    const inbound = yield* seedInbound(2);
    assert.isNotNull(inbound.exchangeId);
    const exchangeId = inbound.exchangeId!;
    const ledger = yield* A2ALedger;
    const appended = yield* ledger.appendEventsIfExchangeOpen(
      silenceAppendCommand(exchangeId, inbound.messageId, "append-before-drop"),
      exchangeId,
    );
    assert.isNotNull(appended);
    assert.isTrue(appended!.committed);

    yield* dropExchange(exchangeId, "append-before-drop");
    const rows = yield* (yield* SqlClient.SqlClient)<{
      readonly dropped: number;
      readonly silence: number;
      readonly silence_deliveries: number;
    }>`
      SELECT
        (SELECT COUNT(*) FROM j5_a2a_comm_event WHERE kind = 'exchange.dropped' AND exchange_id = ${exchangeId}) AS dropped,
        (SELECT COUNT(*) FROM j5_a2a_comm_event WHERE kind = 'silence.notice' AND exchange_id = ${exchangeId}) AS silence,
        (SELECT COUNT(*) FROM j5_a2a_delivery WHERE envelope_channel = 'silence_notice' AND command_id = 'command:silence:serialization:append-before-drop') AS silence_deliveries
    `;
    assert.deepStrictEqual(rows, [{ dropped: 1, silence: 1, silence_deliveries: 1 }]);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("emits never-processed when no turn started after the latest delivery", () =>
  Effect.gen(function* () {
    yield* seed();
    const inbound = yield* seedInbound(4);
    yield* (yield* A2ASilenceDetector).handleDeliveryEvent(inbound.deliveryEvent);
    const notices = yield* readNotices();
    assert.equal(notices[0]?.state, "turn-ended-no-reply");
    if (notices[0]?.state === "turn-ended-no-reply") {
      assert.equal(notices[0].processing, "never-processed");
      assert.isNull(notices[0].runId);
    }
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("daemon retries its stored-event stream and advances the durable cursor", () => {
  const stored = terminalEvent("completed", 130);
  assert.equal(stored.event.type, "run.updated");
  if (stored.event.type !== "run.updated") return Effect.die("expected run.updated fixture");
  const run = stored.event.payload;
  let streamCalls = 0;
  const observedCursors: Array<number> = [];
  const gateEffect = Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const firstFailureObserved = yield* Deferred.make<void>();
    const daemonLayer = makeDaemonTestLayer(
      (input) => {
        streamCalls += 1;
        observedCursors.push(input?.afterSequence ?? 0);
        if (streamCalls === 1) {
          return Stream.concat(
            Stream.fromEffect(Deferred.succeed(firstFailureObserved, undefined)).pipe(Stream.drain),
            Stream.die("simulated stored-event stream failure"),
          );
        }
        if ((input?.afterSequence ?? 0) >= stored.sequence) return Stream.never;
        return Stream.fromEffect(Deferred.await(gate).pipe(Effect.as(stored)));
      },
      [run],
      75,
    );

    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* seed();
        yield* seedInbound(0);
        const committed = yield* (yield* A2ALedger).subscribeCommitted;
        const noticeFiber = yield* committed.pipe(
          Stream.filter((event) => event.kind === "silence.notice"),
          Stream.runHead,
          Effect.forkScoped,
        );
        yield* Deferred.await(firstFailureObserved);
        yield* TestClock.adjust(Duration.millis(250));
        yield* Deferred.succeed(gate, undefined);
        const notice = yield* Fiber.join(noticeFiber);
        assert.isTrue(Option.isSome(notice));

        const sql = yield* SqlClient.SqlClient;
        const cursor = yield* sql<{ readonly after_sequence: number | null }>`
          SELECT after_sequence
          FROM j5_a2a_silence_detector_cursor
          WHERE singleton = 1
        `;
        assert.deepStrictEqual(cursor, [{ after_sequence: stored.sequence }]);
        assert.isAtLeast(streamCalls, 2);
        assert.equal(observedCursors[0], 75);
        assert.notInclude(observedCursors, 0);
      }).pipe(Effect.provide(daemonLayer)),
    );
  });
  return gateEffect;
});

it.effect("backs off exponentially across consecutive lifecycle stream failures", () =>
  Effect.gen(function* () {
    const failures = yield* Queue.unbounded<number>();
    const fourthCall = yield* Deferred.make<void>();
    let streamCalls = 0;
    const daemonLayer = makeDaemonTestLayer(
      () => {
        streamCalls += 1;
        if (streamCalls <= 3) {
          return Stream.concat(
            Stream.fromEffect(Queue.offer(failures, streamCalls)).pipe(Stream.drain),
            Stream.die(`simulated lifecycle failure ${streamCalls}`),
          );
        }
        return Stream.concat(
          Stream.fromEffect(Deferred.succeed(fourthCall, undefined)).pipe(Stream.drain),
          Stream.never,
        );
      },
      [],
      75,
    );

    yield* Effect.scoped(
      Effect.gen(function* () {
        assert.equal(yield* Queue.take(failures), 1);
        yield* TestClock.adjust(Duration.millis(249));
        assert.equal(streamCalls, 1);
        yield* TestClock.adjust(Duration.millis(1));
        assert.equal(yield* Queue.take(failures), 2);

        yield* TestClock.adjust(Duration.millis(499));
        assert.equal(streamCalls, 2);
        yield* TestClock.adjust(Duration.millis(1));
        assert.equal(yield* Queue.take(failures), 3);

        yield* TestClock.adjust(Duration.millis(999));
        assert.equal(streamCalls, 3);
        yield* TestClock.adjust(Duration.millis(1));
        yield* Deferred.await(fourthCall);
        assert.equal(streamCalls, 4);
      }).pipe(Effect.provide(daemonLayer)),
    );
  }),
);

it.effect("attaches the persisted provider detail to an errored notice", () =>
  Effect.gen(function* () {
    yield* seed();
    yield* seedInbound(0);
    yield* (yield* A2ASilenceDetector).handleStoredEvent(terminalEvent("failed"));
    const notices = yield* readNotices();
    assert.equal(notices[0]?.state, "errored");
    if (notices[0]?.state === "errored") assert.deepStrictEqual(notices[0].detail, failureDetail);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("maps interrupted, cancelled, and rolled-back runs to the stop instruction", () =>
  Effect.forEach(
    ["interrupted", "cancelled", "rolled_back"] as const,
    (status, index) =>
      Effect.gen(function* () {
        yield* seed();
        yield* seedInbound(0);
        yield* (yield* A2ASilenceDetector).handleStoredEvent(terminalEvent(status, 110 + index));
        const notices = yield* readNotices();
        assert.equal(notices[0]?.state, "stopped/cancelled");
        if (notices[0]?.state === "stopped/cancelled") {
          assert.equal(notices[0].lifecycleStatus, status);
          assert.equal(notices[0].instruction, STOPPED_NOTICE_INSTRUCTION);
        }
      }).pipe(Effect.provide(makeTestLayer())),
    { concurrency: 1 },
  ).pipe(Effect.asVoid),
);

it.effect("emits awaiting-human with human-knows when the inbox row exists", () =>
  Effect.gen(function* () {
    yield* seed();
    yield* seedInbound(0);
    const outbound = yield* openExchange(subject, person.id, "human-knows");
    assert.isNotNull(outbound.exchangeId);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO j5_a2a_human_inbox_data (
        origin_squadron_id, message_id, exchange_id, sender_id, receiver_id, payload, created_at
      ) VALUES (
        ${squadronId}, ${outbound.messageId}, ${outbound.exchangeId}, ${subject.id},
        ${person.id}, 'Human request', ${iso(1)}
      )
    `;
    yield* markDelivered(
      outbound.messageId,
      outbound.exchangeId!,
      subject.id,
      person.id,
      1,
      "human",
    );

    yield* (yield* A2ASilenceDetector).handleStoredEvent(terminalEvent("completed"));
    const notices = yield* readNotices();
    assert.equal(notices[0]?.state, "awaiting-human");
    if (notices[0]?.state === "awaiting-human") {
      assert.equal(notices[0].humanState, "human-knows");
      assert.equal(notices[0].humanExchangeId, outbound.exchangeId);
    }
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("emits awaiting-human with human-doesnt-know after terminal inbox failure", () =>
  Effect.gen(function* () {
    yield* seed();
    yield* seedInbound(0);
    const outbound = yield* openExchange(subject, person.id, "human-alarmed");
    assert.isNotNull(outbound.exchangeId);
    yield* markAlarmed(outbound.messageId, outbound.exchangeId!, subject.id, person.id);

    yield* (yield* A2ASilenceDetector).handleStoredEvent(terminalEvent("completed"));
    const notices = yield* readNotices();
    assert.equal(notices[0]?.state, "awaiting-human");
    if (notices[0]?.state === "awaiting-human") {
      assert.equal(notices[0].humanState, "human-doesnt-know");
    }
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("stores the blocking peer id structurally", () =>
  Effect.gen(function* () {
    yield* seed();
    yield* seedInbound(0);
    yield* openExchange(subject, peer.id, "older-blocked-peer");
    const newestOutbound = yield* openExchange(subject, newerPeer.id, "newer-blocked-peer", 2);
    assert.isNotNull(newestOutbound.exchangeId);

    yield* (yield* A2ASilenceDetector).handleStoredEvent(terminalEvent("completed"));
    const notices = yield* readNotices();
    assert.equal(notices[0]?.state, "blocked-on-peer");
    if (notices[0]?.state === "blocked-on-peer") {
      assert.equal(notices[0].peerId, newerPeer.id);
      assert.equal(notices[0].peerExchangeId, newestOutbound.exchangeId);
    }
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("emits nothing for an idle agent that owes no reply", () =>
  Effect.gen(function* () {
    yield* seed();
    const appended = yield* (yield* A2ASilenceDetector).handleStoredEvent(
      terminalEvent("completed"),
    );
    assert.deepStrictEqual(appended, []);
    assert.deepStrictEqual(yield* readNotices(), []);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("emits nothing when the human is the quiet recipient", () =>
  Effect.gen(function* () {
    yield* seed();
    const outbound = yield* openExchange(subject, person.id, "human-silence");
    assert.isNotNull(outbound.exchangeId);
    const delivered = yield* markDelivered(
      outbound.messageId,
      outbound.exchangeId!,
      subject.id,
      person.id,
      1,
      "human",
    );
    const appended = yield* (yield* A2ASilenceDetector).handleDeliveryEvent(delivered);
    assert.deepStrictEqual(appended, []);
    assert.deepStrictEqual(yield* readNotices(), []);
  }).pipe(Effect.provide(makeTestLayer())),
);
