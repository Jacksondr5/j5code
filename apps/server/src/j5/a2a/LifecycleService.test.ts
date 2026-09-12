import { assert, it } from "@effect/vitest";
import { EventId, type OrchestrationV2StoredEvent, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import {
  A2ADeliveryTransport,
  A2ADeliveryTransportError,
  type AgentDeliveryInput,
  type HumanDeliveryInput,
} from "./DeliveryTransport.ts";
import { A2ADeliveryWorker, manualLayer as deliveryWorkerLayer } from "./DeliveryWorker.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { A2ALifecycleService, manualLayer as lifecycleLayer } from "./LifecycleService.ts";
import { resolveThreadHome } from "./HomeRegistrar.ts";
import { ParticipantPlacementService, layer as placementLayer } from "./PlacementService.ts";
import { PlacementCommandId } from "./placementContracts.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { A2AParticipantArchivedError, A2ASendService, layer as sendLayer } from "./SendService.ts";
import {
  CommCommandId,
  ExchangeDroppedPayload,
  SquadronId,
  ParticipantId,
  type AgentParticipant,
  type HumanParticipant,
} from "./contracts.ts";

const openedAt = "2026-08-23T12:00:00.000Z";
const archivedAt = "2026-08-23T12:05:00.000Z";
const decodeExchangeDroppedPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ExchangeDroppedPayload),
);

const sender: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:lifecycle:sender"),
  threadId: ThreadId.make("thread:lifecycle:sender"),
};
const receiver: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:lifecycle:receiver"),
  threadId: ThreadId.make("thread:lifecycle:receiver"),
};
const human: HumanParticipant = {
  kind: "human",
  id: ParticipantId.make("human:lifecycle:person"),
};

interface DeliveredNotice {
  readonly channel: "agent" | "human";
  readonly input: AgentDeliveryInput | HumanDeliveryInput;
}

const makeTestLayer = (
  notices: Ref.Ref<ReadonlyArray<DeliveredNotice>>,
  storedEvents: Stream.Stream<OrchestrationV2StoredEvent> = Stream.never,
  failPeerDeliveries = false,
) => {
  const database = NodeSqliteClient.layerMemory();
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const placements = placementLayer.pipe(Layer.provide(database));
  const send = sendLayer.pipe(Layer.provide(ledger), Layer.provide(database));
  const transport = Layer.succeed(
    A2ADeliveryTransport,
    A2ADeliveryTransport.of({
      deliverAgent: (input) =>
        failPeerDeliveries && input.envelopeChannel === "peer"
          ? Effect.fail(
              new A2ADeliveryTransportError({
                operation: "test unavailable provider",
                cause: "offline",
              }),
            )
          : Ref.update(notices, (current) => [...current, { channel: "agent" as const, input }]),
      cancelAgent: () => Effect.succeed("cancelled" as const),
      deliverHuman: (input) =>
        Ref.update(notices, (current) => [...current, { channel: "human" as const, input }]),
    }),
  );
  const worker = deliveryWorkerLayer.pipe(
    Layer.provide(ledger),
    Layer.provide(database),
    Layer.provide(transport),
  );
  const threadManagement = Layer.mock(ThreadManagementService)({
    streamStoredEventsFrom: ({ afterSequence } = {}) =>
      storedEvents.pipe(Stream.filter((event) => event.sequence > (afterSequence ?? 0))),
  });
  const lifecycle = lifecycleLayer.pipe(
    Layer.provide(ledger),
    Layer.provide(worker),
    Layer.provide(database),
    Layer.provide(threadManagement),
  );
  return Layer.mergeAll(
    database,
    ledger,
    send,
    transport,
    worker,
    threadManagement,
    lifecycle,
    placements,
  );
};

const retiredThreadEvent = (
  type: "thread.archived" | "thread.deleted" | "thread.unarchived",
  threadId: ThreadId,
  sequence: number,
): OrchestrationV2StoredEvent =>
  ({
    sequence,
    commandId: null,
    event: {
      id: EventId.make(`event:lifecycle:${type}:${sequence}`),
      type,
      threadId,
      occurredAt: DateTime.makeUnsafe(archivedAt),
      payload: { id: threadId },
    },
  }) as unknown as OrchestrationV2StoredEvent;

const createSquadron = Effect.fn("test.j5.a2a.lifecycle.createSquadron")(function* (
  squadronId: SquadronId,
  name: string,
) {
  yield* (yield* A2ALedger).createSquadron({
    squadron: { id: squadronId, name, createdAt: openedAt },
  });
});

const join = Effect.fn("test.j5.a2a.lifecycle.join")(function* (
  squadronId: SquadronId,
  participant: AgentParticipant,
  suffix: string,
) {
  yield* (yield* A2ALedger).append({
    commandId: CommCommandId.make(`command:lifecycle:join:${suffix}`),
    squadronId,
    acceptedAt: openedAt,
    event: {
      kind: "participant.joined",
      sender: null,
      receiver: participant.id,
      exchangeId: null,
      correlationId: null,
      payload: { participant },
      createdAt: openedAt,
    },
  });
});

it.effect("drops a receiver-retired exchange loudly and rejects new sends to the archive", () =>
  Effect.gen(function* () {
    const notices = yield* Ref.make<ReadonlyArray<DeliveredNotice>>([]);
    yield* Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      const squadronId = SquadronId.make("squadron:lifecycle:receiver-retired");
      yield* createSquadron(squadronId, "Receiver retired");
      yield* join(squadronId, sender, "receiver-retired:sender");
      yield* join(squadronId, receiver, "receiver-retired:receiver");
      const send = yield* A2ASendService;
      const lifecycle = yield* A2ALifecycleService;
      const sql = yield* SqlClient.SqlClient;
      const opened = yield* send.send({
        commandId: CommCommandId.make("command:lifecycle:receiver-retired:open"),
        senderThreadId: sender.threadId,
        to: receiver.id,
        message: "Please answer before retirement.",
        expectReply: true,
        intent: "Prove receiver retirement closure",
        acceptedAt: openedAt,
      });
      assert.isNotNull(opened.exchangeId);
      const exchangeId = opened.exchangeId!;

      const first = yield* lifecycle.archiveParticipant({
        participantId: receiver.id,
        archivedAt,
      });
      const replay = yield* lifecycle.archiveParticipant({
        participantId: receiver.id,
        archivedAt: "2026-08-23T12:06:00.000Z",
      });
      assert.deepStrictEqual(first.droppedExchangeIds, [exchangeId]);
      assert.isTrue(first.archived);
      assert.deepStrictEqual(replay, { archived: false, droppedExchangeIds: [] });

      const exchange = yield* sql<{
        readonly status: string;
        readonly closed_seq: number | null;
      }>`
        SELECT status, closed_seq
        FROM j5_a2a_exchange
        WHERE exchange_id = ${exchangeId}
      `;
      assert.equal(exchange[0]?.status, "dropped");
      assert.isNumber(exchange[0]?.closed_seq);

      const events = yield* sql<{
        readonly kind: string;
        readonly sender: string | null;
        readonly receiver: string | null;
        readonly payload: string;
      }>`
        SELECT kind, sender, receiver, payload
        FROM j5_a2a_comm_event
        WHERE exchange_id = ${exchangeId}
          AND kind IN ('exchange.dropped', 'message.sent')
        ORDER BY seq
      `;
      const dropped = events.find((event) => event.kind === "exchange.dropped");
      assert.equal(dropped?.sender, sender.id);
      assert.equal(dropped?.receiver, receiver.id);
      const droppedPayload = yield* decodeExchangeDroppedPayload(dropped!.payload);
      assert.deepInclude(droppedPayload, {
        disposition: "receiver-retired",
        facts: {
          replyRequired: false,
          retryAllowed: false,
          replacementRequired: false,
        },
      });
      assert.lengthOf(
        events.filter((event) => event.kind === "exchange.dropped"),
        1,
      );
      const retirement = yield* sql<{
        readonly seq: number;
        readonly kind: string;
        readonly squadron_id: string;
        readonly participant_id: string;
        readonly participant_kind: string;
        readonly thread_id: string;
      }>`
        SELECT
          seq,
          kind,
          squadron_id,
          json_extract(payload, '$.participant.id') AS participant_id,
          json_extract(payload, '$.participant.kind') AS participant_kind,
          json_extract(payload, '$.participant.threadId') AS thread_id
        FROM j5_a2a_comm_event
        WHERE kind = 'participant.archived' AND receiver = ${receiver.id}
      `;
      const joinedSequence = yield* sql<{ readonly seq: number }>`
        SELECT seq
        FROM j5_a2a_comm_event
        WHERE kind = 'participant.joined' AND receiver = ${receiver.id}
      `;
      assert.lengthOf(retirement, 1);
      assert.deepInclude(retirement[0]!, {
        kind: "participant.archived",
        squadron_id: squadronId,
        participant_id: receiver.id,
        participant_kind: "agent",
        thread_id: receiver.threadId,
      });
      assert.isAbove(retirement[0]!.seq, joinedSequence[0]!.seq);

      const error = yield* Effect.flip(
        send.send({
          commandId: CommCommandId.make("command:lifecycle:receiver-retired:after"),
          senderThreadId: sender.threadId,
          to: receiver.id,
          message: "This must be rejected.",
          acceptedAt: archivedAt,
        }),
      );
      assert.instanceOf(error, A2AParticipantArchivedError);
      assert.include(error.message, "archived");

      const milestones = yield* (yield* A2ADeliveryWorker).drain;
      assert.isTrue(milestones.some((milestone) => milestone.state === "delivered"));
      const delivered = yield* Ref.get(notices);
      assert.isTrue(
        delivered.some(
          (notice) =>
            notice.input.envelopeChannel === "lifecycle_notice" &&
            notice.input.receiverId === sender.id,
        ),
      );
    }).pipe(Effect.provide(makeTestLayer(notices)));
  }),
);

it.effect("drops a sender-retired person exchange so the active inbox source is terminal", () =>
  Effect.gen(function* () {
    const notices = yield* Ref.make<ReadonlyArray<DeliveredNotice>>([]);
    yield* Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      const squadronId = SquadronId.make("squadron:lifecycle:person");
      yield* createSquadron(squadronId, "Person inbox closure");
      yield* join(squadronId, sender, "person:sender");
      yield* (yield* SqlClient.SqlClient)`
        INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at)
        VALUES (${human.id}, 1, ${openedAt})
      `;
      const opened = yield* (yield* A2ASendService).send({
        commandId: CommCommandId.make("command:lifecycle:person:open"),
        senderThreadId: sender.threadId,
        to: human.id,
        message: "A person should not owe an archived asker.",
        expectReply: true,
        intent: "Prove person inbox closure",
        urgency: "blocking",
        acceptedAt: openedAt,
      });

      yield* (yield* A2ALifecycleService).archiveParticipant({
        participantId: sender.id,
        archivedAt,
      });
      const retiredError = yield* Effect.flip(
        (yield* A2ASendService).send({
          commandId: CommCommandId.make("command:lifecycle:person:retired-send"),
          senderThreadId: sender.threadId,
          to: human.id,
          message: "Retired send must fail.",
          acceptedAt: archivedAt,
        }),
      );
      assert.instanceOf(retiredError, A2AParticipantArchivedError);
      assert.include(retiredError.message, "archived");
      const source = yield* (yield* SqlClient.SqlClient)<{
        readonly status: string;
        readonly disposition: string;
      }>`
        SELECT
          exchange.status,
          json_extract(event.payload, '$.disposition') AS disposition
        FROM j5_a2a_exchange AS exchange
        JOIN j5_a2a_comm_event AS event
          ON event.squadron_id = exchange.squadron_id
          AND event.exchange_id = exchange.exchange_id
          AND event.kind = 'exchange.dropped'
        WHERE exchange.exchange_id = ${opened.exchangeId}
      `;
      assert.deepStrictEqual(source, [{ status: "dropped", disposition: "sender-retired" }]);
      yield* (yield* A2ADeliveryWorker).drain;
      const delivered = yield* Ref.get(notices);
      assert.isTrue(
        delivered.some(
          (notice) =>
            notice.channel === "human" &&
            notice.input.envelopeChannel === "lifecycle_notice" &&
            notice.input.receiverId === human.id,
        ),
      );
    }).pipe(Effect.provide(makeTestLayer(notices)));
  }),
);

it.effect("leaves unrelated same- and cross-Squadron exchanges open", () =>
  Effect.gen(function* () {
    const notices = yield* Ref.make<ReadonlyArray<DeliveredNotice>>([]);
    yield* Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      const localSquadronId = SquadronId.make("squadron:lifecycle:healthy:local");
      const remoteSquadronId = SquadronId.make("squadron:lifecycle:healthy:remote");
      const localPeer: AgentParticipant = {
        kind: "agent",
        id: ParticipantId.make("agent:lifecycle:healthy:local"),
        threadId: ThreadId.make("thread:lifecycle:healthy:local"),
      };
      const secondLocalPeer: AgentParticipant = {
        kind: "agent",
        id: ParticipantId.make("agent:lifecycle:healthy:second-local"),
        threadId: ThreadId.make("thread:lifecycle:healthy:second-local"),
      };
      const remotePeer: AgentParticipant = {
        kind: "agent",
        id: ParticipantId.make("agent:lifecycle:healthy:remote"),
        threadId: ThreadId.make("thread:lifecycle:healthy:remote"),
      };
      yield* createSquadron(localSquadronId, "Healthy local");
      yield* createSquadron(remoteSquadronId, "Healthy remote");
      yield* join(localSquadronId, sender, "healthy:affected-sender");
      yield* join(localSquadronId, receiver, "healthy:affected-receiver");
      yield* join(localSquadronId, localPeer, "healthy:local");
      yield* join(localSquadronId, secondLocalPeer, "healthy:second-local");
      yield* join(remoteSquadronId, remotePeer, "healthy:remote");
      const send = yield* A2ASendService;
      const affected = yield* send.send({
        commandId: CommCommandId.make("command:lifecycle:healthy:affected"),
        senderThreadId: sender.threadId,
        to: receiver.id,
        message: "This obligation should drop.",
        expectReply: true,
        intent: "Affected exchange",
        acceptedAt: openedAt,
      });
      const sameSquadron = yield* send.send({
        commandId: CommCommandId.make("command:lifecycle:healthy:same"),
        senderThreadId: localPeer.threadId,
        to: secondLocalPeer.id,
        message: "This same-Squadron exchange stays open.",
        expectReply: true,
        intent: "Healthy same-Squadron exchange",
        acceptedAt: openedAt,
      });
      const crossSquadron = yield* send.send({
        commandId: CommCommandId.make("command:lifecycle:healthy:cross"),
        senderThreadId: localPeer.threadId,
        to: remotePeer.id,
        message: "This cross-Squadron exchange stays open.",
        expectReply: true,
        intent: "Healthy cross-Squadron exchange",
        acceptedAt: openedAt,
      });

      yield* (yield* A2ALifecycleService).archiveParticipant({
        participantId: receiver.id,
        archivedAt,
      });

      const rows = yield* (yield* SqlClient.SqlClient)<{
        readonly exchange_id: string;
        readonly status: string;
      }>`
        SELECT exchange_id, status
        FROM j5_a2a_exchange
        WHERE exchange_id IN (${affected.exchangeId}, ${sameSquadron.exchangeId}, ${crossSquadron.exchangeId})
        ORDER BY exchange_id
      `;
      assert.deepStrictEqual(Object.fromEntries(rows.map((row) => [row.exchange_id, row.status])), {
        [affected.exchangeId!]: "dropped",
        [sameSquadron.exchangeId!]: "open",
        [crossSquadron.exchangeId!]: "open",
      });
    }).pipe(Effect.provide(makeTestLayer(notices)));
  }),
);

it.effect("replays archive then delete from its cursor without duplicating closure", () =>
  Effect.gen(function* () {
    const notices = yield* Ref.make<ReadonlyArray<DeliveredNotice>>([]);
    const nativeNoHome = retiredThreadEvent(
      "thread.archived",
      ThreadId.make("thread:lifecycle:no-home"),
      6,
    );
    const archived = retiredThreadEvent("thread.archived", receiver.threadId, 7);
    const deleted = retiredThreadEvent("thread.deleted", receiver.threadId, 8);
    const storedEvents = Stream.fromIterable([nativeNoHome, archived, deleted]);
    yield* Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      const squadronId = SquadronId.make("squadron:lifecycle:bridge");
      yield* createSquadron(squadronId, "Archive bridge");
      yield* join(squadronId, sender, "bridge:sender");
      yield* join(squadronId, receiver, "bridge:receiver");
      const opened = yield* (yield* A2ASendService).send({
        commandId: CommCommandId.make("command:lifecycle:bridge:open"),
        senderThreadId: sender.threadId,
        to: receiver.id,
        message: "The committed archive event should close this.",
        expectReply: true,
        intent: "Prove archive bridge replay",
        acceptedAt: openedAt,
      });
      assert.isNotNull(opened.exchangeId);

      const lifecycle = yield* A2ALifecycleService;
      yield* lifecycle.replayCommittedEvents;
      yield* lifecycle.replayCommittedEvents;

      const state = yield* (yield* SqlClient.SqlClient)<{
        readonly status: string;
        readonly dropped_events: number;
        readonly terminal_notices: number;
        readonly after_sequence: number;
      }>`
        SELECT
          exchange.status,
          (
            SELECT COUNT(*)
            FROM j5_a2a_comm_event
            WHERE kind = 'exchange.dropped' AND exchange_id = ${opened.exchangeId}
          ) AS dropped_events,
          (
            SELECT COUNT(*)
            FROM j5_a2a_delivery
            WHERE exchange_role = 'terminal_notice' AND exchange_id = ${opened.exchangeId}
          ) AS terminal_notices,
          cursor.after_sequence
        FROM j5_a2a_exchange AS exchange
        CROSS JOIN j5_a2a_lifecycle_cursor AS cursor
        WHERE exchange.exchange_id = ${opened.exchangeId}
      `;
      assert.deepStrictEqual(state, [
        {
          status: "dropped",
          dropped_events: 1,
          terminal_notices: 1,
          after_sequence: 8,
        },
      ]);
    }).pipe(Effect.provide(makeTestLayer(notices, storedEvents)));
  }),
);

it.effect("drops a reply-owing participant exactly once from committed thread deletion", () =>
  Effect.gen(function* () {
    const notices = yield* Ref.make<ReadonlyArray<DeliveredNotice>>([]);
    const storedEvents = Stream.make(retiredThreadEvent("thread.deleted", receiver.threadId, 11));
    yield* Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      const squadronId = SquadronId.make("squadron:lifecycle:delete-bridge");
      yield* createSquadron(squadronId, "Delete bridge");
      yield* join(squadronId, sender, "delete-bridge:sender");
      yield* join(squadronId, receiver, "delete-bridge:receiver");
      const opened = yield* (yield* A2ASendService).send({
        commandId: CommCommandId.make("command:lifecycle:delete-bridge:open"),
        senderThreadId: sender.threadId,
        to: receiver.id,
        message: "Deleting the receiver must end its reply obligation.",
        expectReply: true,
        intent: "Prove deletion bridge closure",
        acceptedAt: openedAt,
      });
      assert.isNotNull(opened.exchangeId);

      const lifecycle = yield* A2ALifecycleService;
      yield* lifecycle.replayCommittedEvents;
      yield* lifecycle.replayCommittedEvents;

      const state = yield* (yield* SqlClient.SqlClient)<{
        readonly status: string;
        readonly disposition: string;
        readonly dropped_events: number;
        readonly terminal_notices: number;
      }>`
        SELECT
          exchange.status,
          json_extract(dropped.payload, '$.disposition') AS disposition,
          (
            SELECT COUNT(*)
            FROM j5_a2a_comm_event
            WHERE kind = 'exchange.dropped' AND exchange_id = ${opened.exchangeId}
          ) AS dropped_events,
          (
            SELECT COUNT(*)
            FROM j5_a2a_delivery
            WHERE exchange_role = 'terminal_notice' AND exchange_id = ${opened.exchangeId}
          ) AS terminal_notices
        FROM j5_a2a_exchange AS exchange
        JOIN j5_a2a_comm_event AS dropped
          ON dropped.exchange_id = exchange.exchange_id
          AND dropped.kind = 'exchange.dropped'
        WHERE exchange.exchange_id = ${opened.exchangeId}
      `;
      assert.deepStrictEqual(state, [
        {
          status: "dropped",
          disposition: "receiver-retired",
          dropped_events: 1,
          terminal_notices: 1,
        },
      ]);
    }).pipe(Effect.provide(makeTestLayer(notices, storedEvents)));
  }),
);

it.effect(
  "preserves identity and home through archive cycles and ignores replayed old lifecycle events",
  () =>
    Effect.gen(function* () {
      const notices = yield* Ref.make<ReadonlyArray<DeliveredNotice>>([]);
      yield* Effect.gen(function* () {
        yield* runJ5A2AMigrations();
        const squadronId = SquadronId.make("squadron:lifecycle:cycles");
        yield* createSquadron(squadronId, "Cycles");
        yield* join(squadronId, sender, "cycles:sender");
        yield* join(squadronId, receiver, "cycles:receiver");
        const lifecycle = yield* A2ALifecycleService;
        const ledger = yield* A2ALedger;
        const send = yield* A2ASendService;
        const sql = yield* SqlClient.SqlClient;
        const ask = yield* send.send({
          commandId: CommCommandId.make("cycles:ask"),
          senderThreadId: sender.threadId,
          to: receiver.id,
          message: "Old obligation",
          expectReply: true,
          intent: "Check closure",
          acceptedAt: openedAt,
        });
        const archive = retiredThreadEvent("thread.archived", receiver.threadId, 1);
        yield* lifecycle.handleStoredEvent(archive);
        assert.isFalse(
          (yield* send.listParticipants(sender.threadId)).some(
            (row) => row.participantId === receiver.id,
          ),
        );
        const hidden = (yield* send.listParticipants(sender.threadId, true)).find(
          (row) => row.participantId === receiver.id,
        )!;
        assert.isTrue(hidden.archived);
        assert.isFalse(hidden.canReceiveMessage);
        assert.isFalse(hidden.canOpenExchange);
        yield* ledger.rebuildMembership(squadronId);
        assert.isFalse((yield* resolveThreadHome(sql, receiver.threadId)).retired);
        yield* lifecycle.handleStoredEvent(
          retiredThreadEvent("thread.unarchived", receiver.threadId, 2),
        );
        const restored = (yield* send.listParticipants(sender.threadId)).find(
          (row) => row.participantId === receiver.id,
        )!;
        assert.equal(restored.squadronId, squadronId);
        assert.isFalse(restored.archived);
        assert.isTrue(restored.canReceiveMessage);
        const next = yield* send.send({
          commandId: CommCommandId.make("cycles:new-ask"),
          senderThreadId: sender.threadId,
          to: receiver.id,
          message: "New obligation",
          expectReply: true,
          intent: "New cycle",
          acceptedAt: archivedAt,
        });
        yield* lifecycle.handleStoredEvent(archive);
        const state = yield* sql<{
          status: string;
        }>`SELECT status FROM j5_a2a_exchange WHERE exchange_id = ${next.exchangeId}`;
        assert.equal(state[0]?.status, "open");
        yield* lifecycle.handleStoredEvent(
          retiredThreadEvent("thread.archived", receiver.threadId, 3),
        );
        yield* ledger.rebuildMembership(squadronId);
        const events = yield* sql<{
          kind: string;
          count: number;
        }>`SELECT kind, count(*) AS count FROM j5_a2a_comm_event
        WHERE receiver = ${receiver.id} AND kind IN ('participant.joined', 'participant.archived') GROUP BY kind`;
        assert.deepStrictEqual(events, [
          { kind: "participant.archived", count: 2 },
          { kind: "participant.joined", count: 1 },
        ]);
        const cancelled = yield* sql<{
          status: string;
        }>`SELECT status FROM j5_a2a_delivery WHERE message_id = ${ask.messageId}`;
        assert.equal(cancelled[0]?.status, "cancelled");
        yield* (yield* A2ADeliveryWorker).drain;
        assert.isFalse(
          (yield* Ref.get(notices)).some((entry) => entry.input.messageId === ask.messageId),
        );
      }).pipe(Effect.provide(makeTestLayer(notices)));
    }),
);

it.effect(
  "deletes registry and live placement while preserving children, provenance, and peer history",
  () =>
    Effect.gen(function* () {
      const notices = yield* Ref.make<ReadonlyArray<DeliveredNotice>>([]);
      yield* Effect.gen(function* () {
        yield* runJ5A2AMigrations();
        const squadronId = SquadronId.make("squadron:lifecycle:delete");
        yield* createSquadron(squadronId, "Delete");
        yield* join(squadronId, sender, "delete:sender");
        yield* join(squadronId, receiver, "delete:receiver");
        const placements = yield* ParticipantPlacementService;
        yield* placements.recordCreation({
          commandId: PlacementCommandId.make("delete:parent"),
          squadronId,
          participantId: sender.id,
          actor: "platform",
          provenance: { kind: "unknown", source: "native_or_unobserved" },
          createdAt: openedAt,
        });
        const provenance = {
          kind: "spawned-by",
          spawnedByParticipantId: sender.id,
          source: "j5_spawn",
        } as const;
        yield* placements.recordCreation({
          commandId: PlacementCommandId.make("delete:child"),
          squadronId,
          participantId: receiver.id,
          actor: "platform",
          provenance,
          createdAt: openedAt,
        });
        const send = yield* A2ASendService;
        const message = yield* send.send({
          commandId: CommCommandId.make("delete:ask"),
          senderThreadId: receiver.threadId,
          to: sender.id,
          message: "Retain my history",
          expectReply: true,
          intent: "Direct deletion",
          acceptedAt: openedAt,
        });
        const lifecycle = yield* A2ALifecycleService;
        yield* lifecycle.handleStoredEvent(
          retiredThreadEvent("thread.deleted", sender.threadId, 1),
        );
        const rows = yield* placements.listParticipants(squadronId);
        assert.lengthOf(rows, 1);
        assert.equal(rows[0]?.participantId, receiver.id);
        assert.isNull(rows[0]?.placementParentId);
        assert.deepStrictEqual(rows[0]?.provenance, provenance);
        const sql = yield* SqlClient.SqlClient;
        assert.lengthOf(
          yield* sql`SELECT 1 FROM j5_a2a_participant_placement WHERE participant_id = ${sender.id}`,
          0,
        );
        assert.lengthOf(
          yield* sql`SELECT 1 FROM j5_a2a_placement_event WHERE participant_id = ${sender.id}`,
          1,
        );
        assert.lengthOf(
          yield* sql`SELECT 1 FROM j5_a2a_placement_event WHERE kind = 'participant.reparented'`,
          0,
        );
        assert.lengthOf(
          yield* sql`SELECT 1 FROM j5_a2a_comm_event WHERE kind = 'message.sent' AND json_extract(payload, '$.messageId') = ${message.messageId}`,
          1,
        );
        yield* (yield* A2ALedger).rebuildMembership(squadronId);
        yield* lifecycle.handleStoredEvent(
          retiredThreadEvent("thread.unarchived", sender.threadId, 2),
        );
        assert.isTrue((yield* resolveThreadHome(sql, sender.threadId)).retired);
        assert.lengthOf(yield* send.listParticipants(receiver.threadId, true), 1);
        yield* (yield* A2ADeliveryWorker).drain;
        assert.isTrue(
          (yield* Ref.get(notices)).some((entry) => entry.input.message.includes("was deleted")),
        );
      }).pipe(Effect.provide(makeTestLayer(notices)));
    }),
);

it.effect(
  "keeps pre-upgrade retired identities dead across migration, unarchive and membership replay",
  () =>
    Effect.gen(function* () {
      const notices = yield* Ref.make<ReadonlyArray<DeliveredNotice>>([]);
      yield* Effect.gen(function* () {
        yield* runJ5A2AMigrations({ toMigrationInclusive: 10 });
        const squadronId = SquadronId.make("squadron:lifecycle:legacy");
        yield* createSquadron(squadronId, "Legacy");
        yield* join(squadronId, sender, "legacy:sender");
        yield* join(squadronId, receiver, "legacy:receiver");
        const ledger = yield* A2ALedger;
        yield* ledger.append({
          commandId: CommCommandId.make("legacy:retirement"),
          squadronId,
          acceptedAt: archivedAt,
          event: {
            kind: "participant.left",
            sender: null,
            receiver: receiver.id,
            exchangeId: null,
            correlationId: null,
            payload: { participant: receiver },
            createdAt: archivedAt,
          },
        });
        yield* runJ5A2AMigrations();
        yield* (yield* A2ALifecycleService).handleStoredEvent(
          retiredThreadEvent("thread.unarchived", receiver.threadId, 1),
        );
        yield* ledger.rebuildMembership(squadronId);
        yield* runJ5A2AMigrations();
        const sql = yield* SqlClient.SqlClient;
        assert.isTrue((yield* resolveThreadHome(sql, receiver.threadId)).retired);
        assert.lengthOf(yield* (yield* A2ASendService).listParticipants(sender.threadId, true), 1);
        assert.lengthOf(
          yield* sql`SELECT 1 FROM j5_a2a_comm_event WHERE kind = 'participant.unarchived'`,
          0,
        );
      }).pipe(Effect.provide(makeTestLayer(notices)));
    }),
);

it.effect(
  "cancels scheduled retries permanently and retains terminal human history before first delivery",
  () =>
    Effect.gen(function* () {
      const notices = yield* Ref.make<ReadonlyArray<DeliveredNotice>>([]);
      yield* Effect.gen(function* () {
        yield* runJ5A2AMigrations();
        const squadronId = SquadronId.make("squadron:lifecycle:retry");
        yield* createSquadron(squadronId, "Retry closure");
        yield* join(squadronId, sender, "retry:sender");
        yield* join(squadronId, receiver, "retry:receiver");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at) VALUES (${human.id}, 1, ${openedAt})`;
        const send = yield* A2ASendService;
        const peer = yield* send.send({
          commandId: CommCommandId.make("retry:peer"),
          senderThreadId: sender.threadId,
          to: receiver.id,
          message: "Retry me",
          acceptedAt: openedAt,
        });
        const worker = yield* A2ADeliveryWorker;
        assert.equal((yield* worker.runOnce)?.state, "retry_scheduled");
        const ask = yield* send.send({
          commandId: CommCommandId.make("retry:human"),
          senderThreadId: sender.threadId,
          to: human.id,
          message: "Retain this ask",
          expectReply: true,
          intent: "Retained human history",
          urgency: "blocking",
          acceptedAt: openedAt,
        });
        const lifecycle = yield* A2ALifecycleService;
        yield* lifecycle.archiveParticipant({ participantId: sender.id, archivedAt });
        yield* lifecycle.handleStoredEvent(
          retiredThreadEvent("thread.unarchived", sender.threadId, 1),
        );
        const deliveries =
          yield* sql`SELECT status, next_attempt_at FROM j5_a2a_delivery WHERE message_id IN (${peer.messageId}, ${ask.messageId})`;
        assert.deepStrictEqual(deliveries, [
          { status: "cancelled", next_attempt_at: null },
          { status: "cancelled", next_attempt_at: null },
        ]);
        assert.deepStrictEqual(
          yield* sql`SELECT status, latest_message FROM j5_a2a_human_inbox WHERE exchange_id = ${ask.exchangeId}`,
          [{ status: "dropped", latest_message: "Retain this ask" }],
        );
        yield* worker.drain;
        assert.isFalse(
          (yield* Ref.get(notices)).some(
            (notice) =>
              notice.input.messageId === peer.messageId || notice.input.messageId === ask.messageId,
          ),
        );
        assert.lengthOf(
          yield* sql`SELECT 1 FROM j5_a2a_human_person WHERE person_id = ${human.id}`,
          1,
        );
        assert.isTrue(
          (yield* send.listParticipants(receiver.threadId)).some(
            (row) => row.participantId === human.id && !row.archived,
          ),
        );
      }).pipe(Effect.provide(makeTestLayer(notices, Stream.never, true)));
    }),
);

for (const directFirst of [true, false]) {
  it.effect(
    `records one archive fact per transition in both entry-point orders (direct first=${directFirst})`,
    () =>
      Effect.gen(function* () {
        const notices = yield* Ref.make<ReadonlyArray<DeliveredNotice>>([]);
        yield* Effect.gen(function* () {
          yield* runJ5A2AMigrations();
          const squadronId = SquadronId.make(`squadron:archive-order:${directFirst}`);
          yield* createSquadron(squadronId, "Archive order");
          yield* join(squadronId, sender, "order:sender");
          const lifecycle = yield* A2ALifecycleService;
          const sql = yield* SqlClient.SqlClient;
          for (const cycle of [0, 1]) {
            const event = retiredThreadEvent("thread.archived", sender.threadId, cycle * 2 + 1);
            const direct = lifecycle.archiveParticipant({ participantId: sender.id, archivedAt });
            if (directFirst) {
              yield* direct;
              yield* lifecycle.handleStoredEvent(event);
            } else {
              yield* lifecycle.handleStoredEvent(event);
              yield* direct;
            }
            yield* direct;
            yield* lifecycle.handleStoredEvent(event);
            assert.deepStrictEqual(
              yield* sql`SELECT count(*) AS count FROM j5_a2a_comm_event WHERE kind = 'participant.archived'`,
              [{ count: cycle + 1 }],
            );
            yield* lifecycle.handleStoredEvent(
              retiredThreadEvent("thread.unarchived", sender.threadId, cycle * 2 + 2),
            );
            yield* lifecycle.handleStoredEvent(event);
            assert.deepStrictEqual(
              yield* sql`SELECT archived_at FROM j5_a2a_squadron_membership WHERE participant_id = ${sender.id}`,
              [{ archived_at: null }],
            );
          }
          yield* (yield* A2ALedger).rebuildMembership(squadronId);
          assert.deepStrictEqual(
            yield* sql`SELECT archived_at FROM j5_a2a_squadron_membership WHERE participant_id = ${sender.id}`,
            [{ archived_at: null }],
          );
        }).pipe(Effect.provide(makeTestLayer(notices)));
      }),
  );
}
