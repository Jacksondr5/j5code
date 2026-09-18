import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { AgentCrewInstanceService, layer as crewLayer } from "./AgentCrewInstanceService.ts";
import { AgentCrewProposalService, layer as proposalLayer } from "./AgentCrewProposalService.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { A2ASendService, layer as sendLayer } from "./SendService.ts";
import { CommCommandId, ParticipantId, SquadronId } from "./contracts.ts";

const database = NodeSqliteClient.layerMemory();
const ledger = ledgerLayer.pipe(Layer.provide(database));
const testLayer = Layer.mergeAll(
  database,
  ledger,
  crewLayer.pipe(Layer.provide(database)),
  proposalLayer.pipe(Layer.provide(database)),
  sendLayer.pipe(Layer.provide(ledger), Layer.provide(database)),
);
const createdAt = "2026-09-18T12:00:00.000Z";
const participant = (name: string) => ({
  kind: "agent" as const,
  id: ParticipantId.make(`agent:${name}`),
  threadId: ThreadId.make(`thread:${name}`),
});

it.effect(
  "persists direct member and Captain conversations while an addition awaits approval",
  () =>
    Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      const ledgerService = yield* A2ALedger;
      const crews = yield* AgentCrewInstanceService;
      const proposals = yield* AgentCrewProposalService;
      const send = yield* A2ASendService;
      const sql = yield* SqlClient.SqlClient;
      const squadronId = SquadronId.make("squadron:collaboration");
      yield* ledgerService.createSquadron({
        squadron: { id: squadronId, name: "Collaboration", createdAt },
      });
      const captain = participant("captain");
      const otherCaptain = participant("other-captain");
      const reviewer = participant("reviewer");
      const builder = participant("builder");
      for (const member of [captain, otherCaptain, reviewer, builder]) {
        yield* ledgerService.append({
          commandId: CommCommandId.make(`join:${member.id}`),
          squadronId,
          acceptedAt: createdAt,
          event: {
            kind: "participant.joined",
            sender: null,
            receiver: member.id,
            exchangeId: null,
            correlationId: null,
            payload: { participant: member },
            createdAt,
          },
        });
      }
      const crew = yield* crews.record({
        id: "crew:review",
        squadronId,
        captainParticipantId: captain.id,
        captainThreadId: captain.threadId,
        displayName: "Review",
        brief: "Review the change together.",
        createdAt,
        members: [reviewer, builder].map((member) => ({
          seatName: member === reviewer ? "reviewer" : "builder",
          agentId: member === reviewer ? "critic" : null,
          participantId: member.id,
          threadId: member.threadId,
          reason: "Collaborate on the change",
        })),
      });
      yield* crews.record({
        id: "crew:related-work",
        squadronId,
        captainParticipantId: otherCaptain.id,
        captainThreadId: otherCaptain.threadId,
        displayName: "Related work",
        brief: "Coordinate related work.",
        createdAt,
        members: [],
      });
      const pending = yield* proposals.create({
        id: "proposal:security",
        squadronId,
        captainParticipantId: captain.id,
        captainThreadId: captain.threadId,
        crewInstanceId: crew.id,
        kind: "addition",
        displayName: crew.displayName,
        brief: "Review the authorization concern.",
        requestedSeats: [
          {
            seat: "security",
            agentId: null,
            reason: "Authorization concern needs security expertise absent from the roster.",
            instructions: "Review authorization boundaries and report evidence.",
          },
        ],
        createdAt,
      });

      // Neither an artifact nor an Exchange is a prerequisite for any of these conversations.
      const messages = [
        {
          from: reviewer,
          to: builder,
          text: "The new authorization branch drops the owner check.",
        },
        {
          from: reviewer,
          to: captain,
          text: "Security expertise is needed; continue correctness review.",
        },
        { from: captain, to: otherCaptain, text: "Please account for the owner-check concern." },
        { from: otherCaptain, to: captain, text: "Our related change preserves that check." },
        {
          from: builder,
          to: captain,
          text: "Result: guard restored. Evidence: focused tests pass. Blockers: none.",
        },
      ];
      for (const [index, message] of messages.entries()) {
        const input = {
          commandId: CommCommandId.make(`message:collaboration:${index}`),
          senderThreadId: message.from.threadId,
          to: message.to.id,
          message: message.text,
          acceptedAt: createdAt,
        };
        const receipt = yield* send.send(input);
        assert.isNull(receipt.exchangeId);
        assert.equal(receipt.exchangeState, "none");
        assert.deepStrictEqual(yield* send.send(input), receipt);
      }
      const deliveries = yield* sql<{
        readonly sender_id: string;
        readonly receiver_id: string;
        readonly message_text: string;
        readonly exchange_id: string | null;
        readonly status: string;
      }>`
      SELECT sender_id, receiver_id, message_text, exchange_id, status
      FROM j5_a2a_delivery ORDER BY command_id
    `;
      assert.deepStrictEqual(
        deliveries,
        messages.map((message) => ({
          sender_id: message.from.id,
          receiver_id: message.to.id,
          message_text: message.text,
          exchange_id: null,
          status: "pending",
        })),
      );
      assert.equal((yield* proposals.read(pending.id))?.status, "open");
      assert.lengthOf((yield* crews.read(crew.id))!.members, 2);
      const exchanges = yield* sql`SELECT exchange_id FROM j5_a2a_exchange`;
      assert.isEmpty(exchanges);
    }).pipe(Effect.provide(testLayer)),
);
