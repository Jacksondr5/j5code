import { ThreadId } from "@t3tools/contracts";
import { J5_PEER_API_PATHS, type PeerDeliveryRequest } from "@t3tools/contracts/j5";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { EffectOutboxV2 } from "../../orchestration-v2/EffectOutbox.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { A2ADeliveryTransport, live as deliveryTransportLive } from "./DeliveryTransport.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { PeerDirectory, type RemoteAgent } from "./PeerDirectory.ts";
import { PeerRegistryService, type PeerConnection } from "./PeerRegistryService.ts";
import { A2ASendService, layer as sendLayer } from "./SendService.ts";
import {
  CommCommandId,
  CorrelationId,
  ExchangeId,
  LedgerMessageId,
  LIFECYCLE_PARTICIPANT_ID,
  ParticipantId,
  SquadronId,
  type AgentParticipant,
} from "./contracts.ts";

const timestamp = "2026-09-16T12:00:00.000Z";
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const localSquadron = SquadronId.make("squadron:work-billing");
const billing: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:j5:a2a:thread:billing"),
  threadId: ThreadId.make("thread:billing"),
};
const remoteSupport = ParticipantId.make("agent:j5:a2a:thread:support");
const homePeer: PeerConnection = {
  environmentId: "environment-home",
  label: "Home",
  origin: "https://home.example:3773",
  credential: "home-token",
  credentialExpiresAt: null,
  inboundSession: "active",
  createdAt: timestamp,
};
const supportOnHome: RemoteAgent = {
  environmentId: homePeer.environmentId,
  environmentLabel: homePeer.label,
  squadronId: SquadronId.make("squadron:home-support"),
  squadronName: "L2 Support Rotation",
  participantId: remoteSupport,
  threadId: ThreadId.make("thread:support"),
  displayName: "Support triage",
  archived: false,
  canReceiveMessage: true,
};

const directoryLayer = (agents: ReadonlyArray<RemoteAgent>, unreadPeers: ReadonlyArray<string>) =>
  Layer.succeed(
    PeerDirectory,
    PeerDirectory.of({
      listAgents: () =>
        Effect.succeed({
          agents,
          unreadPeers: unreadPeers.map((label) => ({
            environmentId: `environment-${label}`,
            label,
            reason: "ECONNREFUSED",
          })),
        }),
      resolveAgent: (id) =>
        Effect.succeed({
          agents: agents.filter((agent) => agent.participantId === id),
          unreadPeers: unreadPeers.map((label) => ({
            environmentId: `environment-${label}`,
            label,
            reason: "ECONNREFUSED",
          })),
        }),
    }),
  );

const makeSendLayer = (
  agents: ReadonlyArray<RemoteAgent>,
  unreadPeers: ReadonlyArray<string> = [],
) => {
  const database = NodeSqliteClient.layerMemory();
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const send = sendLayer.pipe(
    Layer.provide(ledger),
    Layer.provide(database),
    Layer.provide(directoryLayer(agents, unreadPeers)),
  );
  return Layer.mergeAll(database, ledger, send);
};

const seedLocal = Effect.fn("test.j5.a2a.peer.outbound.seed")(function* () {
  yield* runJ5A2AMigrations();
  const ledger = yield* A2ALedger;
  yield* ledger.createSquadron({
    squadron: { id: localSquadron, name: "Billing Migration", createdAt: timestamp },
  });
  yield* ledger.append({
    commandId: CommCommandId.make("command:peer-outbound:join"),
    squadronId: localSquadron,
    acceptedAt: timestamp,
    event: {
      kind: "participant.joined",
      sender: null,
      receiver: billing.id,
      exchangeId: null,
      correlationId: null,
      payload: { participant: billing },
      createdAt: timestamp,
    },
  });
});

it.effect(
  "resolves a receiver no local Squadron homes through the peer directory and records where it lives",
  () =>
    Effect.gen(function* () {
      yield* seedLocal();
      const send = yield* A2ASendService;
      const sql = yield* SqlClient.SqlClient;
      const sent = yield* send.send({
        commandId: CommCommandId.make("command:peer-outbound:ask"),
        senderThreadId: billing.threadId,
        to: remoteSupport,
        message: "What is the incident status?",
        expectReply: true,
        intent: "incident status",
        acceptedAt: timestamp,
      });
      assert.equal(sent.exchangeState, "open");
      const rows = yield* sql<{
        readonly receiver_squadron_id: string;
        readonly receiver_environment_id: string | null;
        readonly exchange_role: string;
      }>`SELECT receiver_squadron_id, receiver_environment_id, exchange_role FROM j5_a2a_delivery WHERE message_id = ${sent.messageId}`;
      assert.deepStrictEqual(rows, [
        {
          receiver_squadron_id: supportOnHome.squadronId,
          receiver_environment_id: homePeer.environmentId,
          exchange_role: "ask",
        },
      ]);
      const exchange = yield* sql<{ readonly receiver_id: string; readonly squadron_id: string }>`
      SELECT receiver_id, squadron_id FROM j5_a2a_exchange WHERE exchange_id = ${sent.exchangeId!}
    `;
      assert.deepStrictEqual(exchange, [
        { receiver_id: remoteSupport, squadron_id: localSquadron },
      ]);

      const nobody = yield* send
        .send({
          commandId: CommCommandId.make("command:peer-outbound:nobody"),
          senderThreadId: billing.threadId,
          to: ParticipantId.make("agent:j5:a2a:thread:nobody"),
          message: "anyone?",
          acceptedAt: timestamp,
        })
        .pipe(Effect.flip);
      assert.equal(
        nobody._tag,
        "A2AParticipantNotFoundError",
        "a local miss with no peer match stays not found",
      );
    }).pipe(Effect.provide(makeSendLayer([supportOnHome]))),
);

it.effect(
  "refuses an id two peers both carry, an archived remote agent, and names peers it could not read",
  () =>
    Effect.gen(function* () {
      const twice = [
        supportOnHome,
        { ...supportOnHome, environmentId: "environment-mac", environmentLabel: "Mac" },
      ];
      const ambiguous = yield* Effect.gen(function* () {
        yield* seedLocal();
        return yield* (yield* A2ASendService)
          .send({
            commandId: CommCommandId.make("command:peer-outbound:ambiguous"),
            senderThreadId: billing.threadId,
            to: remoteSupport,
            message: "who are you",
            acceptedAt: timestamp,
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(makeSendLayer(twice)));
      assert.equal(ambiguous._tag, "A2AAmbiguousParticipantError");

      const archived = yield* Effect.gen(function* () {
        yield* seedLocal();
        return yield* (yield* A2ASendService)
          .send({
            commandId: CommCommandId.make("command:peer-outbound:archived"),
            senderThreadId: billing.threadId,
            to: remoteSupport,
            message: "still there?",
            acceptedAt: timestamp,
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(makeSendLayer([{ ...supportOnHome, archived: true }])));
      assert.equal(archived._tag, "A2AParticipantArchivedError");

      const unread = yield* Effect.gen(function* () {
        yield* seedLocal();
        return yield* (yield* A2ASendService)
          .send({
            commandId: CommCommandId.make("command:peer-outbound:unread"),
            senderThreadId: billing.threadId,
            to: remoteSupport,
            message: "anyone?",
            acceptedAt: timestamp,
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(makeSendLayer([], ["Home"])));
      assert.equal(unread._tag, "A2APeersUnreadError");
      assert.include(unread.message, "1 peer server(s) could not be read");
      assert.notInclude(unread.message, "Home", "no server is named to the agent");
    }),
);

/** The live transport's peer branch, with the HTTP hop stubbed and everything else in memory. */
const makeTransportLayer = (
  reply: { readonly status: number; readonly body: unknown },
  posted: Array<{ url: string; authorization: string | undefined; body: unknown }>,
) => {
  const database = NodeSqliteClient.layerMemory();
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const send = sendLayer.pipe(
    Layer.provide(ledger),
    Layer.provide(database),
    Layer.provide(directoryLayer([supportOnHome], [])),
  );
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const body =
          request.body._tag === "Uint8Array"
            ? decodeJson(new TextDecoder().decode(request.body.body))
            : null;
        posted.push({ url: request.url, authorization: request.headers.authorization, body });
        return HttpClientResponse.fromWeb(
          request,
          new Response(encodeJson(reply.body), {
            status: reply.status,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    ),
  );
  const transport = deliveryTransportLive.pipe(
    Layer.provide(database),
    Layer.provide(http),
    Layer.provide(
      Layer.mock(PeerRegistryService)({
        connections: () => Effect.succeed([homePeer]),
        connection: (environmentId) =>
          Effect.succeed(environmentId === homePeer.environmentId ? homePeer : null),
      }),
    ),
    Layer.provide(Layer.mock(ThreadManagementService)({})),
    Layer.provide(Layer.mock(OrchestratorV2)({})),
    Layer.provide(Layer.mock(EffectOutboxV2)({})),
  );
  return Layer.mergeAll(database, ledger, send, transport);
};

const crossingAsk = Effect.fn("test.j5.a2a.peer.outbound.crossing")(function* () {
  yield* seedLocal();
  const send = yield* A2ASendService;
  const sent = yield* send.send({
    commandId: CommCommandId.make("command:peer-outbound:live"),
    senderThreadId: billing.threadId,
    to: remoteSupport,
    message: "What is the incident status?",
    expectReply: true,
    intent: "incident status",
    acceptedAt: timestamp,
  });
  const transport = yield* A2ADeliveryTransport;
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ readonly correlation_id: string }>`
    SELECT correlation_id FROM j5_a2a_delivery WHERE message_id = ${sent.messageId}
  `;
  return {
    sent,
    deliver: transport.deliverPeer({
      originSquadronId: localSquadron,
      receiverSquadronId: supportOnHome.squadronId,
      receiverEnvironmentId: homePeer.environmentId,
      correlationId: row!.correlation_id,
      messageId: sent.messageId,
      senderId: billing.id,
      receiverId: remoteSupport,
      exchangeId: ExchangeId.make(sent.exchangeId!),
      exchangeRole: "ask",
      message: "What is the incident status?",
      envelopeChannel: "peer",
      createdAt: timestamp,
    }),
  };
});

it.effect(
  "posts the message to the peer's deliver route with its credential, the intent, and the correlation id",
  () =>
    Effect.gen(function* () {
      const posted: Array<{ url: string; authorization: string | undefined; body: unknown }> = [];
      yield* Effect.gen(function* () {
        const { sent, deliver } = yield* crossingAsk();
        yield* deliver;
        assert.equal(posted.length, 1);
        assert.equal(posted[0]!.url, `${homePeer.origin}${J5_PEER_API_PATHS.deliver}`);
        assert.equal(posted[0]!.authorization, "Bearer home-token");
        const body = posted[0]!.body as PeerDeliveryRequest;
        assert.equal(body.messageId, sent.messageId);
        assert.equal(body.senderId, billing.id);
        assert.equal(body.receiverId, remoteSupport);
        assert.equal(body.exchangeId, sent.exchangeId);
        assert.equal(body.exchangeRole, "ask");
        assert.equal(body.intent, "incident status");
        assert.equal(body.originSquadronId, localSquadron);
        assert.match(body.correlationId, /^correlation:j5:a2a:/);
      }).pipe(
        Effect.provide(
          makeTransportLayer(
            { status: 201, body: { accepted: true, receivedSeq: 3, replay: false } },
            posted,
          ),
        ),
      );
    }),
);

it.effect("turns a peer's refusal into a delivery failure the worker retries and alarms on", () =>
  Effect.gen(function* () {
    const posted: Array<{ url: string; authorization: string | undefined; body: unknown }> = [];
    const failure = yield* Effect.gen(function* () {
      const { deliver } = yield* crossingAsk();
      return yield* Effect.flip(deliver);
    }).pipe(
      Effect.provide(
        makeTransportLayer(
          { status: 404, body: { error: "recipient_not_found", message: "No active agent" } },
          posted,
        ),
      ),
    );
    assert.equal(failure._tag, "A2ADeliveryTransportError");
    assert.include(String(failure.cause), "refused the delivery (HTTP 404)");
  }),
);

it.effect(
  "records a send to a known remote agent while its peer is asleep, from the route the ledger already holds",
  () =>
    Effect.gen(function* () {
      yield* seedLocal();
      const ledger = yield* A2ALedger;
      const send = yield* A2ASendService;
      const sql = yield* SqlClient.SqlClient;
      // An earlier ask reached this agent on Home; that delivery row is the recorded route.
      yield* ledger.append({
        commandId: CommCommandId.make("command:peer-outbound:earlier"),
        squadronId: localSquadron,
        acceptedAt: timestamp,
        event: {
          kind: "message.sent",
          sender: billing.id,
          receiver: remoteSupport,
          exchangeId: null,
          correlationId: CorrelationId.make("correlation:peer-outbound:earlier"),
          payload: {
            messageId: LedgerMessageId.make("message:peer-outbound:earlier"),
            text: "earlier",
            originSquadronId: localSquadron,
            receiverSquadronId: supportOnHome.squadronId,
            receiverEnvironmentId: "environment-Home",
            exchangeRole: "none",
            envelopeChannel: "peer",
          },
          createdAt: timestamp,
        },
      });
      const sent = yield* send.send({
        commandId: CommCommandId.make("command:peer-outbound:asleep"),
        senderThreadId: billing.threadId,
        to: remoteSupport,
        message: "Still there?",
        acceptedAt: timestamp,
      });
      const rows = yield* sql<{
        readonly receiver_environment_id: string | null;
        readonly status: string;
      }>`
      SELECT receiver_environment_id, status FROM j5_a2a_delivery WHERE message_id = ${sent.messageId}
    `;
      assert.deepStrictEqual(rows, [
        { receiver_environment_id: "environment-Home", status: "pending" },
      ]);
    }).pipe(Effect.provide(makeSendLayer([], ["Home"]))),
);

it.effect("never resolves a machine sender's receiver through peers", () =>
  Effect.gen(function* () {
    yield* seedLocal();
    const ledger = yield* A2ALedger;
    const watchdog = ParticipantId.make("machine:watchdog");
    yield* ledger.append({
      commandId: CommCommandId.make("command:peer-outbound:machine-join"),
      squadronId: localSquadron,
      acceptedAt: timestamp,
      event: {
        kind: "participant.joined",
        sender: null,
        receiver: watchdog,
        exchangeId: null,
        correlationId: null,
        payload: { participant: { kind: "machine", id: watchdog, name: "watchdog" } },
        createdAt: timestamp,
      },
    });
    const refused = yield* (yield* A2ASendService)
      .sendAsMachine({
        commandId: CommCommandId.make("command:peer-outbound:machine-remote"),
        senderParticipantId: watchdog,
        to: remoteSupport,
        message: "canary 42",
        acceptedAt: timestamp,
      })
      .pipe(Effect.flip);
    assert.equal(refused._tag, "A2AParticipantNotFoundError");
  }).pipe(Effect.provide(makeSendLayer([supportOnHome]))),
);

it.effect(
  "carries the recorded drop fact on a terminal notice so the peer ends its Exchange the same way",
  () =>
    Effect.gen(function* () {
      const posted: Array<{ url: string; authorization: string | undefined; body: unknown }> = [];
      yield* Effect.gen(function* () {
        const { sent } = yield* crossingAsk();
        const ledger = yield* A2ALedger;
        const exchangeId = ExchangeId.make(sent.exchangeId!);
        const noticeMessageId = LedgerMessageId.make("message:j5:a2a:lifecycle:drop:test");
        yield* ledger.appendEvents({
          commandId: CommCommandId.make("command:peer-outbound:drop"),
          squadronId: localSquadron,
          acceptedAt: timestamp,
          events: [
            {
              kind: "exchange.dropped",
              sender: billing.id,
              receiver: remoteSupport,
              exchangeId,
              correlationId: CorrelationId.make("correlation:peer-outbound:drop"),
              payload: {
                disposition: "sender-retired",
                cause: {
                  kind: "participant-archived",
                  participantId: billing.id,
                  squadronId: localSquadron,
                },
                facts: { replyRequired: false, retryAllowed: false, replacementRequired: false },
                noticeMessageId,
              },
              createdAt: timestamp,
            },
            {
              kind: "message.sent",
              sender: LIFECYCLE_PARTICIPANT_ID,
              receiver: remoteSupport,
              exchangeId,
              correlationId: CorrelationId.make("correlation:peer-outbound:drop"),
              payload: {
                messageId: noticeMessageId,
                text: "exchange dropped",
                originSquadronId: localSquadron,
                receiverSquadronId: supportOnHome.squadronId,
                receiverEnvironmentId: homePeer.environmentId,
                exchangeRole: "terminal_notice",
                envelopeChannel: "lifecycle_notice",
              },
              createdAt: timestamp,
            },
          ],
        });
        const transport = yield* A2ADeliveryTransport;
        yield* transport.deliverPeer({
          originSquadronId: localSquadron,
          receiverSquadronId: supportOnHome.squadronId,
          receiverEnvironmentId: homePeer.environmentId,
          messageId: noticeMessageId,
          senderId: LIFECYCLE_PARTICIPANT_ID,
          receiverId: remoteSupport,
          exchangeId,
          exchangeRole: "terminal_notice",
          message: "exchange dropped",
          envelopeChannel: "lifecycle_notice",
          createdAt: timestamp,
        });
        const body = posted.at(-1)!.body as PeerDeliveryRequest;
        assert.equal(body.exchangeRole, "terminal_notice");
        assert.deepStrictEqual(body.terminal, {
          disposition: "sender-retired",
          cause: {
            kind: "participant-archived",
            participantId: billing.id,
            squadronId: localSquadron,
          },
        });
        assert.isUndefined(body.intent);
      }).pipe(
        Effect.provide(
          makeTransportLayer(
            { status: 201, body: { accepted: true, receivedSeq: 9, replay: false } },
            posted,
          ),
        ),
      );
    }),
);
