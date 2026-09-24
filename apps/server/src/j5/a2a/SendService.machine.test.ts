import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { noneLayer as peerDirectoryNoneLayer } from "./PeerDirectory.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { A2ASendService, layer as sendLayer } from "./SendService.ts";
import {
  type AgentParticipant,
  CommCommandId,
  type MachineParticipant,
  ParticipantId,
  SquadronId,
} from "./contracts.ts";

const timestamp = "2026-09-15T12:00:00.000Z";
const squadronId = SquadronId.make("squadron:monitoring");

const agent: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:j5:a2a:thread:sentinel"),
  threadId: ThreadId.make("thread:sentinel"),
};
const watchdog: MachineParticipant = {
  kind: "machine",
  id: ParticipantId.make("machine:watchdog"),
  name: "watchdog",
};

const makeTestLayer = () => {
  const database = NodeSqliteClient.layerMemory();
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const send = sendLayer.pipe(
    Layer.provide(peerDirectoryNoneLayer),
    Layer.provide(ledger),
    Layer.provide(database),
  );
  return Layer.mergeAll(database, ledger, send);
};

const setup = Effect.fn("test.j5.a2a.machineSend.setup")(function* () {
  yield* runJ5A2AMigrations();
  const ledger = yield* A2ALedger;
  yield* ledger.createSquadron({
    squadron: { id: squadronId, name: "Monitoring", createdAt: timestamp },
  });
  for (const [index, participant] of [agent, watchdog].entries()) {
    yield* ledger.append({
      commandId: CommCommandId.make(`command:join:${String(index)}`),
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
});

it.effect(
  "commits a machine's plain send on the ordinary path, attributed to the machine, and replays it",
  () =>
    Effect.gen(function* () {
      yield* setup();
      const service = yield* A2ASendService;
      const sql = yield* SqlClient.SqlClient;

      const input = {
        commandId: CommCommandId.make("command:machine:send:canary-42"),
        senderParticipantId: watchdog.id,
        to: agent.id,
        message: "canary 42",
        acceptedAt: timestamp,
      };
      const sent = yield* service.sendAsMachine(input);
      assert.equal(sent.exchangeState, "none");
      assert.isNull(sent.exchangeId);

      const deliveries = yield* sql<{
        readonly sender_id: string;
        readonly receiver_id: string;
        readonly exchange_role: string;
      }>`SELECT sender_id, receiver_id, exchange_role FROM j5_a2a_delivery WHERE message_id = ${sent.messageId}`;
      assert.deepStrictEqual(deliveries, [
        { sender_id: watchdog.id, receiver_id: agent.id, exchange_role: "none" },
      ]);

      const events = yield* sql<{ readonly sender: string; readonly payload: string }>`
      SELECT sender, payload FROM j5_a2a_comm_event WHERE kind = 'message.sent'
    `;
      assert.equal(events.length, 1);
      assert.equal(events[0]!.sender, watchdog.id);
      assert.include(events[0]!.payload, '"envelopeChannel":"peer"');

      assert.deepStrictEqual(
        yield* service.sendAsMachine(input),
        sent,
        "the same command id replays the original receipt without a second row",
      );
      assert.equal(
        (yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM j5_a2a_delivery`)[0]!
          .count,
        1,
      );
    }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("refuses an unregistered machine sender and any send addressed to a machine", () =>
  Effect.gen(function* () {
    yield* setup();
    const service = yield* A2ASendService;

    const ghost = yield* Effect.flip(
      service.sendAsMachine({
        commandId: CommCommandId.make("command:machine:send:ghost"),
        senderParticipantId: ParticipantId.make("machine:ghost"),
        to: agent.id,
        message: "boo",
        acceptedAt: timestamp,
      }),
    );
    assert.equal(ghost._tag, "A2AMachineSenderNotRegisteredError");

    const toMachine = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:agent:send:to-machine"),
        senderThreadId: agent.threadId,
        to: watchdog.id,
        message: "are you there?",
        acceptedAt: timestamp,
      }),
    );
    assert.equal(toMachine._tag, "A2AMachineCannotReceiveError");

    const toUnknownMachine = yield* Effect.flip(
      service.send({
        commandId: CommCommandId.make("command:agent:send:to-unknown-machine"),
        senderThreadId: agent.threadId,
        to: ParticipantId.make("machine:nobody"),
        message: "hello?",
        acceptedAt: timestamp,
      }),
    );
    assert.equal(toUnknownMachine._tag, "A2AParticipantNotFoundError");
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("lists a machine in the address book as a named sender that receives nothing", () =>
  Effect.gen(function* () {
    yield* setup();
    const service = yield* A2ASendService;
    const rows = yield* service.listParticipants(agent.threadId);
    const machineRow = rows.find((row) => row.participantId === watchdog.id);
    assert.deepStrictEqual(machineRow, {
      squadronId,
      participantId: watchdog.id,
      participant: watchdog,
      archived: false,
      canReceiveMessage: false,
      canOpenExchange: false,
      acceptsUrgency: false,
    });
  }).pipe(Effect.provide(makeTestLayer())),
);
