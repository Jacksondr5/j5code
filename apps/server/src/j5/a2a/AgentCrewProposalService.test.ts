import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { AgentCrewInstanceService, layer as crewLayer } from "./AgentCrewInstanceService.ts";
import {
  AgentCrewProposalService,
  layer as proposalLayer,
  type CreateCrewProposalInput,
} from "./AgentCrewProposalService.ts";
import { crewSeatThreadId } from "./crewSeatIds.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { ParticipantId, SquadronId } from "./contracts.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const testLayer = Layer.mergeAll(
  database,
  ledgerLayer.pipe(Layer.provide(database)),
  crewLayer.pipe(Layer.provide(database)),
  proposalLayer.pipe(Layer.provide(database)),
);
const createdAt = "2026-09-22T09:00:00.000Z";
const squadronId = SquadronId.make("squadron:crew-proposals");
const captain = ParticipantId.make("agent:j5:a2a:captain-proposals");
const captainThreadId = ThreadId.make("thread:captain-proposals");

const seat = (name: string) => ({ seat: name, agentId: "scout", reason: "Holds a seat" });

/** A roster row minted by a launch: its identity is its own, not derived from any proposal. */
const rosterMember = (crewId: string, name: string) => ({
  seatName: name,
  agentId: "scout",
  participantId: ParticipantId.make(`agent:j5:a2a:thread:${crewId}:${name}`),
  threadId: ThreadId.make(`thread:${crewId}:${name}`),
  reason: null,
});

/** The row an addition reserves for one of its seats, under the ids the launcher derives. */
const reservedMember = (proposalId: string, name: string) => {
  const threadId = crewSeatThreadId(proposalId, name);
  return {
    seatName: name,
    agentId: "scout",
    participantId: participantIdForThread(threadId),
    threadId,
    reason: null,
  };
};

const addition = (
  id: string,
  crewInstanceId: string,
  seats: ReadonlyArray<string>,
): CreateCrewProposalInput => ({
  id,
  squadronId,
  captainParticipantId: captain,
  captainThreadId,
  crewInstanceId,
  kind: "addition",
  brief: "Join in.",
  displayName: "Counted",
  requestedSeats: seats.map(seat),
  createdAt,
});

it.effect(
  "admits against rows and open requests, and files one of two racing for the last seat",
  () =>
    Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      yield* (yield* A2ALedger).createSquadron({
        squadron: { id: squadronId, name: "Proposal Squadron", createdAt },
      });
      const crews = yield* AgentCrewInstanceService;
      const proposals = yield* AgentCrewProposalService;
      const crewId = "crew:counted";
      yield* crews.record({
        id: crewId,
        squadronId,
        captainParticipantId: captain,
        captainThreadId,
        displayName: "Counted",
        brief: "Join in.",
        createdAt,
        members: Array.from({ length: 9 }, (_, index) => rosterMember(crewId, `s${index}`)),
      });

      // Nine rows and P's two open seats leave room for one more; a resolved request holds nothing.
      const p = yield* proposals.admit(addition("proposal:p", crewId, ["p", "p-two"]), {
        maxSeats: 12,
      });
      assert.equal(p.status, "created");
      const declined = yield* proposals.admit(addition("proposal:d", crewId, ["d"]), {
        maxSeats: 12,
      });
      assert.equal(declined.status, "created");
      const claimed = yield* proposals.claim({
        id: "proposal:d",
        decision: "decline",
        approvedSeats: null,
      });
      assert.isNotNull(claimed);
      assert.isNotNull(
        yield* proposals.complete({
          id: "proposal:d",
          decision: "decline",
          crewInstanceId: crewId,
          resolvedAt: createdAt,
        }),
      );

      // Two requests racing for that last seat: one is filed, one refused and never written.
      const a = addition("proposal:a", crewId, ["a"]);
      const b = addition("proposal:b", crewId, ["b"]);
      const [left, right] = yield* Effect.all(
        [proposals.admit(a, { maxSeats: 12 }), proposals.admit(b, { maxSeats: 12 })],
        { concurrency: "unbounded" },
      );
      assert.sameMembers([left.status, right.status], ["created", "cap-exceeded"]);
      const [winner, loser] = left.status === "created" ? [a, b] : [b, a];
      assert.deepStrictEqual(left.status === "created" ? right : left, {
        status: "cap-exceeded",
        held: 12,
        adding: 1,
      });
      assert.isNull(yield* proposals.read(loser.id));

      // The winner's replay finds its row before anything is counted, though the Crew is full.
      const replay = yield* proposals.admit(winner, { maxSeats: 12 });
      assert.equal(replay.status, "existing");
      if (replay.status === "existing") assert.equal(replay.proposal.id, winner.id);
      assert.equal((yield* proposals.admit(loser, { maxSeats: 12 })).status, "cap-exceeded");
    }).pipe(Effect.provide(testLayer)),
);

it.effect("an open addition whose failed launch left its reserved row is counted once", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    yield* (yield* A2ALedger).createSquadron({
      squadron: { id: squadronId, name: "Proposal Squadron", createdAt },
    });
    const crews = yield* AgentCrewInstanceService;
    const proposals = yield* AgentCrewProposalService;
    const crewId = "crew:reserved";
    yield* crews.record({
      id: crewId,
      squadronId,
      captainParticipantId: captain,
      captainThreadId,
      displayName: "Reserved",
      brief: "Join in.",
      createdAt,
      members: Array.from({ length: 10 }, (_, index) => rosterMember(crewId, `s${index}`)),
    });
    // P is open again after its launch failed, with its one reserved row still on the Crew.
    const p = yield* proposals.admit(addition("proposal:p", crewId, ["p"]), { maxSeats: 12 });
    assert.equal(p.status, "created");
    assert.equal(
      (yield* crews.addMembers(crewId, [reservedMember("proposal:p", "p")])).status,
      "added",
    );

    // Eleven held, not twelve: Q takes the last seat and R is refused.
    const q = yield* proposals.admit(addition("proposal:q", crewId, ["q"]), { maxSeats: 12 });
    assert.equal(q.status, "created");
    assert.deepStrictEqual(
      yield* proposals.admit(addition("proposal:r", crewId, ["r"]), { maxSeats: 12 }),
      { status: "cap-exceeded", held: 12, adding: 1 },
    );
  }).pipe(Effect.provide(testLayer)),
);
