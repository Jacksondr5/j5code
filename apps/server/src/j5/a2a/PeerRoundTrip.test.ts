import {
  EventId,
  MessageId,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import { PeerCapabilities, PeerDeliveryRequest, PeerDeliveryResponse } from "@t3tools/contracts/j5";
import { ownPeerCapabilities } from "./peerProtocol.ts";
import { readFleetLedgerFacts } from "./fleetFacts.ts";
import { readsChangedByLedgerEvent } from "./ReadChangeFeeds.ts";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { layer as crewInstanceLayer } from "./AgentCrewInstanceService.ts";
import {
  A2ADeliveryHooks,
  A2ADeliveryWorker,
  layerWithHooks as deliveryWorkerLayerWithHooks,
} from "./DeliveryWorker.ts";
import {
  A2ADeliveryTransport,
  A2ADeliveryTransportError,
  type AgentDeliveryInput,
  deliveryMessageId,
  type PeerDeliveryInput,
} from "./DeliveryTransport.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { A2ALifecycleService, manualLayer as lifecycleLayer } from "./LifecycleService.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { PeerDirectory, type RemoteAgent } from "./PeerDirectory.ts";
import {
  A2APeerLandingRefusedError,
  PeerInboundService,
  layer as peerInboundLayer,
  peerDeliveryRefusal,
  type PeerInboundServiceShape,
} from "./PeerInboundService.ts";
import { peerRefusalReason } from "./deliveryNotices.ts";
import { A2ASendService, layer as sendLayer } from "./SendService.ts";
import { A2ASilenceDetector, manualLayer as silenceDetectorLayer } from "./SilenceDetector.ts";
import {
  CommCommandId,
  ExchangeId,
  ParticipantId,
  LedgerProjectId,
  type AgentParticipant,
  LIFECYCLE_PARTICIPANT_ID,
  type StoredCommEvent,
} from "./contracts.ts";

/**
 * Two servers, each with its own database, ledger, send service, inbound
 * service, and worker. The peer transport of each hands the message straight to
 * the other's inbound service, standing in for the HTTP hop, so what is under
 * test is the protocol: an ask crosses, opens the Exchange on both sides, is
 * answered, and the reply closes both.
 */

const timestamp = "2026-09-16T12:00:00.000Z";
const isPeerDelivery = Schema.is(PeerDeliveryRequest);
const isPeerReceipt = Schema.is(PeerDeliveryResponse);
const decodePeerCapabilities = Schema.decodeUnknownSync(PeerCapabilities);
const decodeLegacyCapabilities = Schema.decodeUnknownSync(
  Schema.Struct({
    poll: Schema.optionalKey(Schema.Boolean),
    landing: Schema.optionalKey(Schema.Boolean),
  }),
);

interface Server {
  readonly environmentId: string;
  readonly projectId: LedgerProjectId;
  readonly agent: AgentParticipant;
}

const work: Server = {
  environmentId: "environment-work",
  projectId: LedgerProjectId.make("project:work-billing"),
  agent: {
    kind: "agent",
    id: ParticipantId.make("agent:j5:a2a:thread:billing"),
    threadId: ThreadId.make("thread:billing"),
  },
};
const home: Server = {
  environmentId: "environment-home",
  projectId: LedgerProjectId.make("project:home-support"),
  agent: {
    kind: "agent",
    id: ParticipantId.make("agent:j5:a2a:thread:support"),
    threadId: ThreadId.make("thread:support"),
  },
};

const remoteView = (server: Server, label: string): RemoteAgent => ({
  environmentId: server.environmentId,
  environmentLabel: label,
  projectId: server.projectId,
  projectTitle: label,
  participantId: server.agent.id,
  threadId: server.agent.threadId,
  displayName: label,
  archived: false,
  canReceiveMessage: true,
  available: true,
  lastAvailableAt: null,
});

/** One server's runtime; `peer` is the other server's inbound door, wired after both exist. */
const roundTripRunId = (thread: ThreadId) => RunId.make(`run:roundtrip:${thread}`);

const makeServer = (
  self: Server,
  other: Server,
  otherLabel: string,
  peer: Ref.Ref<PeerInboundServiceShape | null>,
  delivered: Ref.Ref<Array<AgentDeliveryInput>>,
  crossed: Ref.Ref<Array<PeerDeliveryInput>>,
  failLocal = false,
) => {
  const database = NodeSqliteClient.layer({ filename: ":memory:" });
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const directory = Layer.succeed(
    PeerDirectory,
    PeerDirectory.of({
      listAgents: () =>
        Effect.succeed({
          agents: [remoteView(other, otherLabel)],
          unreadPeers: [],
          selfName: self.environmentId,
        }),
      resolveAgent: (id) =>
        Effect.succeed({
          agents: id === other.agent.id ? [remoteView(other, otherLabel)] : [],
          unreadPeers: [],
          selfName: self.environmentId,
        }),
      snapshotAgent: () => Effect.succeed(null),
      serverStatus: () =>
        Effect.succeed({ name: otherLabel, available: true, lastAvailableAt: null }),
    }),
  );
  const send = sendLayer.pipe(
    Layer.provide(ledger),
    Layer.provide(database),
    Layer.provide(directory),
  );
  const inbound = peerInboundLayer.pipe(Layer.provide(ledger), Layer.provide(database));
  const transport = Layer.succeed(
    A2ADeliveryTransport,
    A2ADeliveryTransport.of({
      cancelAgent: () => Effect.succeed("cancelled" as const),
      deliverAgent: (input) =>
        failLocal
          ? Effect.fail(
              new A2ADeliveryTransportError({
                operation: "private-path/token-local-error",
                cause: "private-secret",
              }),
            )
          : Ref.update(delivered, (rows) => [...rows, input]),
      deliverHuman: () => Effect.void,
      deliverPeer: (input) =>
        Effect.gen(function* () {
          const door = yield* Ref.get(peer);
          if (door === null) {
            return yield* new A2ADeliveryTransportError({
              operation: "deliver to peer",
              cause: "peer is unreachable",
            });
          }
          yield* Ref.update(crossed, (rows) => [...rows, input]);
          // The body the worker built is exactly what the live transport puts on the wire.
          yield* door
            .receive({ ...input.body, originEnvironmentId: self.environmentId })
            .pipe(
              Effect.mapError(
                (cause) => new A2ADeliveryTransportError({ operation: "deliver to peer", cause }),
              ),
            );
        }),
    }),
  );
  const worker = deliveryWorkerLayerWithHooks(false).pipe(
    Layer.provide(ledger),
    Layer.provide(database),
    Layer.provide(transport),
    Layer.provide(
      Layer.succeed(
        A2ADeliveryHooks,
        A2ADeliveryHooks.of({ afterTransportSuccess: () => Effect.void }),
      ),
    ),
  );
  // Archiving and silence run the real lifecycle service and silence detector;
  // the scenarios hand them thread events directly, so the stream stays empty.
  const threads = Layer.mock(ThreadManagementService)({
    streamStoredEventsFrom: () => Stream.never,
    getThreadProjection: () =>
      Effect.succeed({ runs: [], turnItems: [] } as unknown as OrchestrationV2ThreadProjection),
    // Every message delivered to an agent here belongs to its thread's one run (`runEnded`).
    getThreadRecords: ((threadId: ThreadId) =>
      Ref.get(delivered).pipe(
        Effect.map((rows) => ({
          runs: [{ id: roundTripRunId(threadId) }],
          messages: rows.map((row) => ({
            id: deliveryMessageId(row.messageId),
            runId: roundTripRunId(threadId),
          })),
        })),
      )) as never,
  });
  const lifecycle = lifecycleLayer.pipe(
    Layer.provide(ledger),
    Layer.provide(worker),
    Layer.provide(database),
    Layer.provide(threads),
  );
  const silence = silenceDetectorLayer.pipe(
    Layer.provide(ledger),
    Layer.provide(database),
    Layer.provide(threads),
    Layer.provide(Layer.mock(EventSinkV2)({})),
    Layer.provide(crewInstanceLayer.pipe(Layer.provide(database))),
    Layer.provide(worker),
  );
  return Layer.mergeAll(database, ledger, send, inbound, worker, lifecycle, silence);
};

/** The stored event for a run that ended on `thread`, as the silence detector reads it. */
const runEnded = (thread: ThreadId, status: "completed" | "failed"): OrchestrationV2StoredEvent => {
  const runId = roundTripRunId(thread);
  const at = DateTime.makeUnsafe("2026-09-16T12:00:03.000Z");
  return {
    sequence: 100,
    commandId: null,
    event: {
      id: EventId.make(`event:roundtrip:${thread}:${status}`),
      type: "run.updated",
      threadId: thread,
      runId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      occurredAt: at,
      payload: {
        id: runId,
        threadId: thread,
        ordinal: 1,
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
        providerThreadId: null,
        userMessageId: MessageId.make(`message:roundtrip:${thread}`),
        rootNodeId: null,
        activeAttemptId: null,
        status,
        requestedAt: DateTime.makeUnsafe("2026-09-16T12:00:00.000Z"),
        startedAt: DateTime.makeUnsafe("2026-09-16T12:00:01.000Z"),
        completedAt: at,
        checkpointId: null,
        contextHandoffId: null,
      },
    },
  } as OrchestrationV2StoredEvent;
};

/** One server's project and agent, and its record of the server it is peered with. */
const seed = Effect.fn("test.j5.a2a.peer.roundtrip.seed")(function* (self: Server, peer: Server) {
  yield* runJ5A2AMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO j5_a2a_peer (environment_id, label, link_mode, origin, credential, peer_capabilities, created_at, updated_at)
    VALUES (${peer.environmentId}, ${peer.environmentId}, 'push', 'https://peer.example', 'peer-token', '{"deliveryAlarms":true}', ${timestamp}, ${timestamp})
  `;
  const ledger = yield* A2ALedger;
  yield* ledger.ensureProject({ projectId: self.projectId, createdAt: timestamp });
  yield* ledger.append({
    commandId: CommCommandId.make(`command:roundtrip:join:${self.agent.id}`),
    projectId: self.projectId,
    acceptedAt: timestamp,
    event: {
      kind: "participant.joined",
      sender: null,
      receiver: self.agent.id,
      exchangeId: null,
      correlationId: null,
      payload: { participant: self.agent },
      createdAt: timestamp,
    },
  });
  return {
    send: yield* A2ASendService,
    inbound: yield* PeerInboundService,
    worker: yield* A2ADeliveryWorker,
    lifecycle: yield* A2ALifecycleService,
    silence: yield* A2ASilenceDetector,
    ledger,
    sql: yield* SqlClient.SqlClient,
  };
});

/** Both servers up and introduced, with Work's agent holding an open ask to Home's agent that has crossed. */
const pairWithOpenAsk = Effect.fn("test.j5.a2a.peer.roundtrip.pairWithOpenAsk")(function* (
  commandId: string,
  failHome = false,
) {
  const workDoor = yield* Ref.make<PeerInboundServiceShape | null>(null);
  const homeDoor = yield* Ref.make<PeerInboundServiceShape | null>(null);
  const workDelivered = yield* Ref.make<Array<AgentDeliveryInput>>([]);
  const homeDelivered = yield* Ref.make<Array<AgentDeliveryInput>>([]);
  const crossed = yield* Ref.make<Array<PeerDeliveryInput>>([]);
  const workContext = yield* Layer.build(
    makeServer(work, home, "Home", homeDoor, workDelivered, crossed),
  );
  const homeContext = yield* Layer.build(
    makeServer(home, work, "Work", workDoor, homeDelivered, crossed, failHome),
  );
  const workServer = yield* seed(work, home).pipe(Effect.provide(workContext));
  const homeServer = yield* seed(home, work).pipe(Effect.provide(homeContext));
  yield* Ref.set(workDoor, workServer.inbound);
  yield* Ref.set(homeDoor, homeServer.inbound);
  const asked = yield* workServer.send.send({
    commandId: CommCommandId.make(commandId),
    senderThreadId: work.agent.threadId,
    to: home.agent.id,
    message: "What is the incident status?",
    expectReply: true,
    intent: "incident status",
    acceptedAt: timestamp,
  });
  assert.equal((yield* workServer.worker.runOnce)?.state, "delivered");
  assert.equal(
    (yield* homeServer.worker.runOnce)?.state,
    failHome ? "retry_scheduled" : "delivered",
  );
  assert.equal(
    (yield* Ref.get(homeDelivered)).length,
    failHome ? 0 : 1,
    "the ask's thread delivery",
  );
  return {
    workServer,
    homeServer,
    workDelivered,
    homeDelivered,
    crossed,
    exchangeId: ExchangeId.make(asked.exchangeId!),
    messageId: asked.messageId,
  };
});

const exchangeStatus = (sql: SqlClient.SqlClient, exchangeId: string) =>
  sql<{ readonly status: string; readonly sender_id: string }>`
    SELECT status, sender_id FROM j5_a2a_exchange WHERE exchange_id = ${exchangeId}
  `;

it.effect(
  "carries an ask from one server to another and the reply back, closing both Exchanges",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const workDoor = yield* Ref.make<PeerInboundServiceShape | null>(null);
        const homeDoor = yield* Ref.make<PeerInboundServiceShape | null>(null);
        const workDelivered = yield* Ref.make<Array<AgentDeliveryInput>>([]);
        const homeDelivered = yield* Ref.make<Array<AgentDeliveryInput>>([]);
        const workCrossed = yield* Ref.make<Array<PeerDeliveryInput>>([]);
        const homeCrossed = yield* Ref.make<Array<PeerDeliveryInput>>([]);

        // Two runtimes with two databases, both alive for the whole scenario.
        const workContext = yield* Layer.build(
          makeServer(work, home, "Home", homeDoor, workDelivered, workCrossed),
        );
        const homeContext = yield* Layer.build(
          makeServer(home, work, "Work", workDoor, homeDelivered, homeCrossed),
        );
        const workServer = yield* seed(work, home).pipe(Effect.provide(workContext));
        const homeServer = yield* seed(home, work).pipe(Effect.provide(homeContext));
        yield* Ref.set(workDoor, workServer.inbound);
        yield* Ref.set(homeDoor, homeServer.inbound);
        // Home's record of Work carries the name Work reported for itself at hello.
        yield* homeServer.sql`
          UPDATE j5_a2a_peer SET label = 'Work VM' WHERE environment_id = ${work.environmentId}
        `;

        // Work asks Home by participant id, naming no server.
        const asked = yield* workServer.send.send({
          commandId: CommCommandId.make("command:roundtrip:ask"),
          senderThreadId: work.agent.threadId,
          to: home.agent.id,
          message: "What is the incident status?",
          expectReply: true,
          intent: "incident status",
          acceptedAt: timestamp,
        });
        assert.equal(asked.exchangeState, "open");
        assert.equal(asked.receiverServer, "Home", "the send names where the receiver lives");
        const askRow = yield* workServer.sql<{
          readonly receiver_environment_id: string | null;
          readonly receiver_project_id: string;
        }>`SELECT receiver_environment_id, receiver_project_id FROM j5_a2a_delivery WHERE message_id = ${asked.messageId}`;
        assert.deepStrictEqual(askRow, [
          { receiver_environment_id: home.environmentId, receiver_project_id: home.projectId },
        ]);

        // Work's worker crosses; Home records its own row and delivers locally.
        assert.equal((yield* workServer.worker.runOnce)?.state, "delivered");
        assert.equal((yield* Ref.get(workCrossed)).length, 1);
        assert.deepStrictEqual(yield* Ref.get(workDelivered), [], "nothing was injected on Work");
        const workReceived = yield* workServer.sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM j5_a2a_comm_event WHERE kind = 'message.received'
    `;
        assert.deepStrictEqual(
          workReceived,
          [{ count: 0 }],
          "the peer writes the received row, not the sender",
        );
        assert.deepStrictEqual(yield* exchangeStatus(homeServer.sql, asked.exchangeId!), [
          { status: "open", sender_id: work.agent.id },
        ]);
        assert.equal((yield* homeServer.worker.runOnce)?.state, "delivered");
        const homeInjected = yield* Ref.get(homeDelivered);
        assert.equal(homeInjected.length, 1);
        assert.equal(
          homeInjected[0]!.originProjectId,
          work.projectId,
          "the envelope names Work's project",
        );
        assert.equal(homeInjected[0]!.senderId, work.agent.id);
        assert.equal(homeInjected[0]!.senderServerName, "Work VM", "and the server it came from");

        // Home replies to the Exchange it now holds; the reply crosses back and closes Work's Exchange.
        const replied = yield* homeServer.send.send({
          commandId: CommCommandId.make("command:roundtrip:reply"),
          senderThreadId: home.agent.threadId,
          to: work.agent.id,
          message: "Resolved at 09:41.",
          exchangeId: ExchangeId.make(asked.exchangeId!),
          acceptedAt: timestamp,
        });
        assert.equal(replied.exchangeState, "closed");
        assert.deepStrictEqual(yield* exchangeStatus(homeServer.sql, asked.exchangeId!), [
          { status: "closed", sender_id: work.agent.id },
        ]);
        assert.deepStrictEqual(yield* exchangeStatus(workServer.sql, asked.exchangeId!), [
          { status: "open", sender_id: work.agent.id },
        ]);
        assert.equal((yield* homeServer.worker.runOnce)?.state, "delivered");
        assert.deepStrictEqual(yield* exchangeStatus(workServer.sql, asked.exchangeId!), [
          { status: "closed", sender_id: work.agent.id },
        ]);
        assert.equal((yield* workServer.worker.runOnce)?.state, "delivered");
        const workInjected = yield* Ref.get(workDelivered);
        assert.equal(workInjected.length, 1);
        assert.equal(workInjected[0]!.exchangeRole, "reply");
        assert.equal(workInjected[0]!.message, "Resolved at 09:41.");
        assert.isNull(yield* workServer.worker.runOnce);
        assert.isNull(yield* homeServer.worker.runOnce);
      }),
    ),
);

it.effect(
  "carries a steer across with its sender's limit, and refuses it for an agent above that limit",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { workServer, homeServer, homeDelivered, crossed } = yield* pairWithOpenAsk(
          "command:roundtrip:landing-ask",
        );
        // Only Home knows its agent's modes; upstream keeps them on the thread's projection,
        // in the schema upstream's own migrations create.
        yield* runMigrations().pipe(Effect.provideService(SqlClient.SqlClient, homeServer.sql));
        yield* homeServer.sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode,
            interaction_mode, active_provider_thread_id, created_at, updated_at,
            archived_at, deleted_at, payload_json
          ) VALUES (
            ${home.agent.threadId}, ${home.projectId}, 'Home agent', 'codex', 'approval-required',
            'default', NULL, ${timestamp}, ${timestamp}, NULL, NULL, '{}'
          )
        `;
        const limit = { runtimeMode: "approval-required", interactionMode: "default" } as const;
        yield* workServer.send.send({
          commandId: CommCommandId.make("command:roundtrip:steer"),
          senderThreadId: work.agent.threadId,
          to: home.agent.id,
          message: "Stop the deploy, the migration is wrong.",
          mode: "steer",
          modeLimit: limit,
          acceptedAt: timestamp,
        });
        assert.equal((yield* workServer.worker.runOnce)?.state, "delivered");
        assert.deepStrictEqual((yield* Ref.get(crossed)).at(-1)?.body.landing, {
          mode: "steer",
          limit,
        });
        assert.equal((yield* homeServer.worker.runOnce)?.state, "delivered");
        const steered = (yield* Ref.get(homeDelivered)).at(-1);
        assert.equal(steered?.mode, "steer", "Home lands it as Work's agent asked");
        assert.deepStrictEqual(steered?.modeLimit, limit);

        // Home's agent is raised above what Work's agent may touch: the restart is refused,
        // and nothing is recorded or delivered on Home.
        yield* homeServer.sql`
          UPDATE orchestration_v2_projection_threads SET runtime_mode = 'full-access'
          WHERE thread_id = ${home.agent.threadId}
        `;
        const refused = yield* workServer.send.send({
          commandId: CommCommandId.make("command:roundtrip:restart"),
          senderThreadId: work.agent.threadId,
          to: home.agent.id,
          message: "Start over from the last good commit.",
          mode: "restart",
          modeLimit: limit,
          acceptedAt: timestamp,
        });
        // This harness hands a refusal back as a plain failure; over HTTP it is the final
        // `landing_refused` answer below, which the sender is told about and does not retry.
        yield* workServer.worker.runOnce;
        const failure = yield* workServer.sql<{ readonly last_error: string }>`
          SELECT last_error FROM j5_a2a_delivery WHERE message_id = ${refused.messageId}
        `;
        assert.include(failure[0]?.last_error ?? "", "so the restart is refused");
        assert.deepStrictEqual(
          peerDeliveryRefusal(
            new A2APeerLandingRefusedError({
              participantId: home.agent.id,
              mode: "restart",
              exceeded: "runtime",
            }),
          ),
          {
            status: 403,
            code: "landing_refused",
            message: `${home.agent.id} runs with a broader permission mode than the sender, so the restart is refused.`,
          },
        );
        assert.include(
          peerRefusalReason({ serverName: "Home", code: "landing_refused", message: "" }),
          "Send it again without mode",
        );
        assert.equal(yield* homeServer.worker.runOnce, null, "Home has nothing to deliver");
        assert.lengthOf(yield* Ref.get(homeDelivered), 2, "the ask and the steer, and no restart");
      }),
    ),
);

it.effect(
  "alarms the sender when the peer cannot be reached, and never writes a received row anywhere",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const noDoor = yield* Ref.make<PeerInboundServiceShape | null>(null);
        const delivered = yield* Ref.make<Array<AgentDeliveryInput>>([]);
        const crossed = yield* Ref.make<Array<PeerDeliveryInput>>([]);
        const context = yield* Layer.build(
          makeServer(work, home, "Home", noDoor, delivered, crossed),
        );
        const server = yield* seed(work, home).pipe(Effect.provide(context));
        const sent = yield* server.send.send({
          commandId: CommCommandId.make("command:roundtrip:dark"),
          senderThreadId: work.agent.threadId,
          to: home.agent.id,
          message: "Anyone there?",
          acceptedAt: timestamp,
        });
        const first = yield* server.worker.runOnce;
        assert.equal(first?.state, "retry_scheduled");
        assert.equal(first?.messageId, sent.messageId);
        const state = yield* server.sql<{ readonly status: string; readonly last_error: string }>`
      SELECT status, last_error FROM j5_a2a_delivery WHERE message_id = ${sent.messageId}
    `;
        assert.equal(state[0]?.status, "retry_scheduled");
        assert.include(state[0]?.last_error ?? "", "peer is unreachable");
        assert.deepStrictEqual(yield* Ref.get(delivered), []);
      }),
    ),
);

it.effect(
  "carries a withdrawal across: the answerer's Exchange closes and its thread is never woken",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pair = yield* pairWithOpenAsk("command:roundtrip:withdraw:ask");
        const { workServer, homeServer, exchangeId } = pair;

        const cleared = yield* workServer.send.clearOwnAsk({
          commandId: CommCommandId.make("command:roundtrip:withdraw:clear"),
          senderThreadId: work.agent.threadId,
          exchangeId,
          acceptedAt: timestamp,
        });
        assert.isTrue(cleared.withdrawalQueued);
        assert.deepStrictEqual(yield* exchangeStatus(workServer.sql, exchangeId), [
          { status: "closed", sender_id: work.agent.id },
        ]);

        // The withdrawal crosses as a platform notice carrying the fact it was written with.
        assert.equal((yield* workServer.worker.runOnce)?.state, "delivered");
        const notice = (yield* Ref.get(pair.crossed)).at(-1)!;
        assert.equal(notice.body.exchangeRole, "terminal_notice");
        assert.deepStrictEqual(notice.body.terminal, { kind: "sender-cleared" });

        const closure = yield* homeServer.sql<{
          readonly status: string;
          readonly closure: string;
        }>`
          SELECT e.status, json_extract(c.payload, '$.closureKind') AS closure
          FROM j5_a2a_exchange e
          JOIN j5_a2a_comm_event c ON c.exchange_id = e.exchange_id AND c.kind = 'exchange.closed'
          WHERE e.exchange_id = ${exchangeId}
        `;
        assert.deepStrictEqual(closure, [{ status: "closed", closure: "sender-cleared" }]);
        // Nothing is queued for Home's agent: a withdrawal wakes nobody, as it does locally.
        assert.isNull(yield* homeServer.worker.runOnce);
        assert.equal((yield* Ref.get(pair.homeDelivered)).length, 1, "only the ask was injected");
        // And the debt is gone: Home's agent can no longer answer it.
        const late = yield* Effect.flip(
          homeServer.send.send({
            commandId: CommCommandId.make("command:roundtrip:withdraw:late-reply"),
            senderThreadId: home.agent.threadId,
            to: work.agent.id,
            message: "Resolved.",
            exchangeId,
            acceptedAt: timestamp,
          }),
        );
        assert.equal(late._tag, "A2AExchangeNotOpenError");
      }),
    ),
);

it.effect(
  "carries a drop across when the asker is archived: the answerer's side judges the disposition and is told",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pair = yield* pairWithOpenAsk("command:roundtrip:archive:ask");
        const { workServer, homeServer, exchangeId } = pair;

        const archived = yield* workServer.lifecycle.archiveParticipant({
          participantId: work.agent.id,
          archivedAt: timestamp,
        });
        assert.deepStrictEqual(archived.droppedExchangeIds, [exchangeId]);

        // The drop notice goes to the answerer, on Home, with the retirement but no disposition.
        assert.equal((yield* workServer.worker.runOnce)?.state, "delivered");
        const notice = (yield* Ref.get(pair.crossed)).at(-1)!;
        assert.equal(notice.body.receiverId, home.agent.id);
        assert.deepStrictEqual(notice.body.terminal, {
          kind: "dropped",
          cause: {
            kind: "participant-archived",
            participantId: work.agent.id,
            projectId: work.projectId,
          },
        });

        const dropped = yield* homeServer.sql<{
          readonly status: string;
          readonly disposition: string;
        }>`
          SELECT e.status, json_extract(c.payload, '$.disposition') AS disposition
          FROM j5_a2a_exchange e
          JOIN j5_a2a_comm_event c ON c.exchange_id = e.exchange_id AND c.kind = 'exchange.dropped'
          WHERE e.exchange_id = ${exchangeId}
        `;
        assert.deepStrictEqual(dropped, [{ status: "dropped", disposition: "sender-retired" }]);
        // Unlike a withdrawal, a drop is news: Home's agent is told its asker is gone.
        assert.equal((yield* homeServer.worker.runOnce)?.state, "delivered");
        const told = (yield* Ref.get(pair.homeDelivered)).at(-1)!;
        assert.equal(told.envelopeChannel, "lifecycle_notice");
        assert.equal(told.exchangeRole, "terminal_notice");
        assert.isNull(yield* homeServer.worker.runOnce);
      }),
    ),
);

it.effect(
  "tells the asker on the other server when the answerer ends its turn without replying",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pair = yield* pairWithOpenAsk("command:roundtrip:silence:ask");
        const { workServer, homeServer, exchangeId } = pair;

        // Home's answerer finishes a run owing the reply; Home's detector measures it.
        const measured = yield* homeServer.silence.handleStoredEvent(
          runEnded(home.agent.threadId, "completed"),
        );
        assert.equal(measured.length, 1);
        const crossing = yield* homeServer.worker.runOnce;
        const why = yield* homeServer.sql<{ readonly last_error: string | null }>`
          SELECT last_error FROM j5_a2a_delivery WHERE envelope_channel = 'silence_notice'
        `;
        assert.equal(crossing?.state, "delivered", why[0]?.last_error ?? "");
        const notice = (yield* Ref.get(pair.crossed)).at(-1)!;
        assert.equal(notice.body.envelopeChannel, "silence_notice");
        assert.equal(notice.body.receiverId, work.agent.id);
        assert.equal(notice.body.regardingExchangeId, exchangeId, "the notice names its Exchange");

        // Work accepts it for the Exchange it holds with Home and tells its waiting agent.
        assert.equal((yield* workServer.worker.runOnce)?.state, "delivered");
        const told = (yield* Ref.get(pair.workDelivered)).at(-1)!;
        assert.equal(told.envelopeChannel, "silence_notice");
        assert.equal(told.receiverId, work.agent.id);
        // Silence is news, not an ending: the debt stands on both sides.
        assert.deepStrictEqual(yield* exchangeStatus(workServer.sql, exchangeId), [
          { status: "open", sender_id: work.agent.id },
        ]);
        assert.deepStrictEqual(yield* exchangeStatus(homeServer.sql, exchangeId), [
          { status: "open", sender_id: work.agent.id },
        ]);
      }),
    ),
);

it.effect(
  "reports accepted peer messages that later fail in-thread without changing acceptance or closing the ask",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pair = yield* pairWithOpenAsk("command:remote-alarm", true);
        const original = () =>
          pair.workServer.sql`SELECT * FROM j5_a2a_delivery WHERE message_id = ${pair.messageId}`;
        const before = yield* original();
        yield* TestClock.adjust("250 millis");
        assert.equal((yield* pair.homeServer.worker.runOnce)?.state, "retry_scheduled");
        yield* TestClock.adjust("500 millis");
        assert.equal((yield* pair.homeServer.worker.runOnce)?.state, "alarmed");
        assert.equal(
          (yield* pair.homeServer.worker.runOnce)?.state,
          "delivered",
          "the fact crosses the real peer transport",
        );
        assert.deepStrictEqual(yield* original(), before, "the origin acceptance is immutable");
        const facts = yield* readFleetLedgerFacts(
          pair.workServer.sql,
          work.projectId,
          [work.agent.id],
          () => null,
        );
        const problems = facts.problems.get(work.agent.id)!;
        assert.equal(problems.length, 1);
        assert.isTrue(problems[0]?.kind === "delivery-failed" && problems[0].exchangeOpen);
        assert.notInclude(JSON.stringify(problems), "private-");
        assert.equal(
          (yield* exchangeStatus(pair.workServer.sql, pair.exchangeId))[0]?.status,
          "open",
        );
        assert.equal(
          (yield* Ref.get(pair.workDelivered)).length,
          0,
          "the fact is never injected into the sender thread",
        );
        const event = (yield* pair.workServer.sql<{
          readonly kind: string;
          readonly payload: string;
        }>`
      SELECT kind, payload FROM j5_a2a_comm_event WHERE json_extract(payload, '$.peerReported') = 1`)[0]!;
        assert.equal(event.kind, "message.delivery_failed");
        assert.equal(
          (yield* pair.workServer
            .sql`SELECT 1 FROM j5_a2a_comm_event WHERE kind IN ('message.received','silence.notice')`)
            .length,
          0,
        );
        assert.equal((yield* pair.workServer.sql`SELECT 1 FROM j5_a2a_human_inbox`).length, 0);
        assert.include(
          readsChangedByLedgerEvent({
            kind: event.kind,
            receiver: home.agent.id,
            payload: JSON.parse(event.payload),
          } as StoredCommEvent),
          "fleet",
        );
        yield* pair.workServer.send.clearOwnAsk({
          commandId: CommCommandId.make("command:remote-alarm-clear"),
          senderThreadId: work.agent.threadId,
          exchangeId: pair.exchangeId,
          acceptedAt: timestamp,
        });
        const cleared = yield* readFleetLedgerFacts(
          pair.workServer.sql,
          work.projectId,
          [work.agent.id],
          () => null,
        );
        assert.equal(cleared.problems.get(work.agent.id)?.length, 1, "the historical chip stays");
        const clearedProblem = cleared.problems.get(work.agent.id)![0]!;
        assert.isFalse(clearedProblem.kind === "delivery-failed" && clearedProblem.exchangeOpen);
      }),
    ),
);

it.effect(
  "binds alarm facts only to accepted authored messages for the authenticated peer, idempotently",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pair = yield* pairWithOpenAsk("command:report-binding");
        const sql = pair.workServer.sql;
        const report = {
          messageId: "envelope:report",
          senderId: LIFECYCLE_PARTICIPANT_ID,
          receiverId: "ignored:receiver",
          originProjectId: "ignored:project",
          exchangeId: null,
          exchangeRole: "none" as const,
          envelopeChannel: "lifecycle_notice" as const,
          correlationId: "ignored:correlation",
          text: "PRIVATE PEER TEXT",
          createdAt: "2999-01-01T00:00:00Z",
          deliveryAlarm: { messageId: pair.messageId, code: "attempts-exhausted" as const },
          originEnvironmentId: home.environmentId,
        };
        const count = () => sql`SELECT * FROM j5_a2a_peer_delivery_alarm`;
        const ignored = yield* pair.workServer.inbound.receive({
          ...report,
          deliveryAlarm: { ...report.deliveryAlarm, messageId: "not-sent" },
        });
        assert.isTrue(isPeerReceipt({ accepted: true, ...ignored }));
        yield* sql`INSERT INTO j5_a2a_peer(environment_id,label,link_mode,origin,credential,created_at,updated_at)
      VALUES ('foreign','foreign','push','https://foreign.example','credential',${timestamp},${timestamp})`;
        assert.deepStrictEqual(
          yield* pair.workServer.inbound.receive({ ...report, originEnvironmentId: "foreign" }),
          ignored,
        );
        for (const status of ["cancelled", "alarmed"]) {
          yield* sql`UPDATE j5_a2a_delivery SET status = ${status} WHERE message_id = ${pair.messageId}`;
          assert.deepStrictEqual(yield* pair.workServer.inbound.receive(report), ignored);
        }
        yield* sql`UPDATE j5_a2a_delivery SET status='delivered', origin_environment_id='relayed' WHERE message_id=${pair.messageId}`;
        assert.deepStrictEqual(yield* pair.workServer.inbound.receive(report), ignored);
        yield* sql`UPDATE j5_a2a_delivery SET origin_environment_id=NULL, status='pending' WHERE message_id=${pair.messageId}`;
        const pending = yield* Effect.flip(pair.workServer.inbound.receive(report));
        assert.equal(pending._tag, "A2APeerDeliveryReceiptPendingError");
        assert.equal((yield* count()).length, 0);
        yield* sql`UPDATE j5_a2a_delivery SET status='delivered' WHERE message_id=${pair.messageId}`;
        yield* sql`UPDATE j5_a2a_membership SET archived_at=${timestamp} WHERE participant_id=${work.agent.id}`;
        assert.deepStrictEqual(yield* pair.workServer.inbound.receive(report), ignored);
        yield* sql`UPDATE j5_a2a_membership SET archived_at=NULL WHERE participant_id=${work.agent.id}`;
        const membership = yield* sql<{
          readonly payload: string;
          readonly project_id: string;
          readonly participant_id: string;
          readonly participant_kind: string;
          readonly thread_id: string;
          readonly joined_seq: number;
          readonly updated_seq: number;
          readonly archived_at: string | null;
        }>`SELECT * FROM j5_a2a_membership WHERE participant_id=${work.agent.id}`;
        yield* sql`DELETE FROM j5_a2a_membership WHERE participant_id=${work.agent.id}`;
        assert.deepStrictEqual(yield* pair.workServer.inbound.receive(report), ignored);
        yield* sql`INSERT INTO j5_a2a_membership ${sql.insert(membership)}`;
        const before = yield* sql`SELECT * FROM j5_a2a_delivery WHERE message_id=${pair.messageId}`;
        assert.deepStrictEqual(yield* pair.workServer.inbound.receive(report), ignored);
        yield* TestClock.adjust("1 minute");
        assert.deepStrictEqual(
          yield* pair.workServer.inbound.receive({ ...report, messageId: "another-envelope" }),
          ignored,
        );
        const stored = yield* count();
        assert.equal(stored.length, 1);
        assert.equal(
          stored[0]!.reported_at,
          "1970-01-01T00:00:00.000Z",
          "only the origin receipt clock is authoritative",
        );
        assert.notInclude(JSON.stringify(stored), "PRIVATE");
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM j5_a2a_delivery WHERE message_id=${pair.messageId}`,
          before,
        );
        assert.equal(
          (yield* sql`SELECT 1 FROM j5_a2a_comm_event WHERE json_extract(payload,'$.peerReported')=1`)
            .length,
          1,
        );
        for (const changed of [
          { senderId: home.agent.id, envelopeChannel: "peer" as const },
          { exchangeId: "foreign" },
          { exchangeRole: "terminal_notice" as const },
          { regardingExchangeId: "foreign" },
          { terminal: { kind: "sender-cleared" as const } },
          {
            landing: {
              mode: "steer" as const,
              limit: { runtimeMode: "full-access" as const, interactionMode: "default" as const },
            },
          },
        ]) {
          assert.equal(
            (yield* Effect.flip(pair.workServer.inbound.receive({ ...report, ...changed })))._tag,
            "A2APeerSenderNotAllowedError",
          );
        }
        assert.isFalse(
          isPeerDelivery({
            ...report,
            deliveryAlarm: { messageId: "x".repeat(4097), code: "attempts-exhausted" },
          }),
        );
        assert.isFalse(
          isPeerDelivery({
            ...report,
            deliveryAlarm: { messageId: "m", code: "unbounded-peer-code" },
          }),
        );
        yield* sql`UPDATE j5_a2a_delivery SET exchange_id=NULL WHERE message_id=${pair.messageId}`;
        const plain = (yield* readFleetLedgerFacts(
          sql,
          work.projectId,
          [work.agent.id],
          () => null,
        )).problems.get(work.agent.id)![0]!;
        assert.isTrue(
          plain.kind === "delivery-failed" && !plain.exchangeOpen,
          "plain message alarms do not become open-Exchange alarms",
        );
        yield* sql`DELETE FROM j5_a2a_peer_delivery_alarm`;
        yield* sql`UPDATE j5_a2a_delivery SET status='cancelled' WHERE message_id=${pair.messageId}`;
        const staleEvent = (yield* sql<{
          readonly payload: string;
        }>`SELECT payload FROM j5_a2a_comm_event WHERE json_extract(payload,'$.peerReported')=1`)[0]!;
        yield* pair.workServer.ledger.append({
          commandId: CommCommandId.make("command:stale-peer-report"),
          projectId: work.projectId,
          acceptedAt: timestamp,
          event: {
            kind: "message.delivery_failed",
            sender: work.agent.id,
            receiver: home.agent.id,
            exchangeId: null,
            correlationId: null,
            payload: JSON.parse(staleEvent.payload),
            createdAt: timestamp,
          },
        });
        assert.equal(
          (yield* count()).length,
          0,
          "a stale projection never fails or resurrects a cancelled delivery",
        );
        yield* sql`INSERT INTO j5_a2a_peer_delivery_alarm(project_id,message_id,reported_at,reason)
          VALUES (${work.projectId},${pair.messageId},${timestamp},'historical failure')`;
        yield* sql`DELETE FROM j5_a2a_delivery WHERE project_id=${work.projectId} AND message_id=${pair.messageId}`;
        assert.equal(
          (yield* count()).length,
          0,
          "deleting the delivery cascades to its diagnostic fact",
        );
      }),
    ),
);

it.effect(
  "does not send diagnostic facts to an old peer or recurse on an alarmed platform fact",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pair = yield* pairWithOpenAsk("command:old-peer-alarm", true);
        yield* pair.homeServer.sql`UPDATE j5_a2a_peer SET peer_capabilities='{}'`;
        yield* TestClock.adjust("250 millis");
        yield* pair.homeServer.worker.runOnce;
        yield* TestClock.adjust("500 millis");
        assert.equal((yield* pair.homeServer.worker.runOnce)?.state, "alarmed");
        assert.equal(
          (yield* pair.homeServer
            .sql`SELECT 1 FROM j5_a2a_delivery WHERE envelope_channel='lifecycle_notice'`).length,
          0,
        );
        yield* pair.homeServer
          .sql`UPDATE j5_a2a_peer SET peer_capabilities='{"deliveryAlarms":true}'`;
        const report = (yield* Ref.get(pair.crossed))[0]!.body;
        const received = yield* pair.homeServer.inbound.receive({
          ...report,
          messageId: "other-message",
          correlationId: "correlation:other-message",
          exchangeId: null,
          exchangeRole: "none",
          originEnvironmentId: work.environmentId,
        });
        assert.isAtLeast(received.receivedSeq, 1);
        yield* pair.homeServer.worker.runOnce;
        yield* TestClock.adjust("250 millis");
        yield* pair.homeServer.worker.runOnce;
        yield* TestClock.adjust("500 millis");
        yield* pair.homeServer.worker.runOnce;
        yield* pair.workServer.sql`DELETE FROM j5_a2a_peer`;
        yield* pair.homeServer.worker.runOnce;
        yield* TestClock.adjust("250 millis");
        yield* pair.homeServer.worker.runOnce;
        yield* TestClock.adjust("500 millis");
        yield* pair.homeServer.worker.runOnce;
        assert.equal(
          (yield* pair.homeServer
            .sql`SELECT 1 FROM j5_a2a_delivery WHERE envelope_channel='lifecycle_notice'`).length,
          1,
        );
      }),
    ),
);

it.effect("retries an early alarm report until the matching origin acceptance is committed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const pair = yield* pairWithOpenAsk("command:early-report", true);
      yield* pair.workServer
        .sql`UPDATE j5_a2a_delivery SET status='pending' WHERE message_id=${pair.messageId}`;
      yield* TestClock.adjust("250 millis");
      yield* pair.homeServer.worker.runOnce;
      yield* TestClock.adjust("500 millis");
      yield* pair.homeServer.worker.runOnce;
      assert.equal((yield* pair.homeServer.worker.runOnce)?.state, "retry_scheduled");
      assert.equal(
        (yield* pair.workServer.sql`SELECT 1 FROM j5_a2a_peer_delivery_alarm`).length,
        0,
      );
      yield* pair.workServer
        .sql`UPDATE j5_a2a_delivery SET status='delivered' WHERE message_id=${pair.messageId}`;
      yield* TestClock.adjust("250 millis");
      assert.equal((yield* pair.homeServer.worker.runOnce)?.state, "delivered");
      assert.equal(
        (yield* pair.workServer.sql`SELECT 1 FROM j5_a2a_peer_delivery_alarm`).length,
        1,
      );
    }),
  ),
);

it("keeps delivery-alarm capabilities additive for old peer decoders", () => {
  assert.deepStrictEqual(decodePeerCapabilities({ poll: true, landing: true }), {
    poll: true,
    landing: true,
  });
  assert.deepStrictEqual(decodeLegacyCapabilities(ownPeerCapabilities), {
    poll: true,
    landing: true,
  });
});
