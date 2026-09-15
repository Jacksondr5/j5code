import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { AgentCrewInstanceService, layer as crewLayer } from "./AgentCrewInstanceService.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { ParticipantId, SquadronId } from "./contracts.ts";

const database = NodeSqliteClient.layerMemory();
const testLayer = Layer.mergeAll(
  database,
  ledgerLayer.pipe(Layer.provide(database)),
  crewLayer.pipe(Layer.provide(database)),
);
const createdAt = "2026-09-09T16:00:00.000Z";

it.effect("records a crew once, exposes membership, and lists by captain", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const squadronId = SquadronId.make("squadron:crew-instances");
    yield* (yield* A2ALedger).createSquadron({
      squadron: { id: squadronId, name: "Crew Squadron", createdAt },
    });
    const service = yield* AgentCrewInstanceService;
    const captain = ParticipantId.make("agent:j5:a2a:captain");
    const input = {
      id: "crew:j5:a2a:mcp:session:spawn-crew:req",
      squadronId,
      captainParticipantId: captain,
      captainThreadId: ThreadId.make("thread:captain"),
      displayName: "Review Pair",
      brief: "Implement and review the login fix.",
      createdAt,
      members: [
        {
          seatName: "builder",
          agentId: "builder",
          participantId: ParticipantId.make("agent:j5:a2a:thread:builder"),
          threadId: ThreadId.make("thread:builder"),
          reason: "Implements the fix",
        },
        {
          seatName: "critic",
          agentId: "critic",
          participantId: ParticipantId.make("agent:j5:a2a:thread:critic"),
          threadId: ThreadId.make("thread:critic"),
          reason: null,
        },
      ],
    };
    const first = yield* service.record(input);
    const replay = yield* service.record({ ...input, displayName: "Changed later" });
    assert.deepStrictEqual(replay, first);
    assert.equal(first.displayName, "Review Pair");
    assert.deepStrictEqual(
      first.members.map(({ seatName }) => seatName),
      ["builder", "critic"],
    );
    assert.isNull(first.archivedAt);
    assert.deepStrictEqual(yield* service.findMembership(input.members[1]!.participantId), {
      crewInstanceId: input.id,
      seatName: "critic",
    });
    assert.isNull(yield* service.findMembership(captain));
    assert.deepStrictEqual(yield* service.read(input.id), first);
    assert.isNull(yield* service.read("missing"));
    assert.deepStrictEqual(
      yield* service.listForCaptain({ squadronId, captainParticipantId: captain }),
      [first],
    );
    assert.deepStrictEqual(
      yield* service.listForCaptain({
        squadronId,
        captainParticipantId: ParticipantId.make("agent:j5:a2a:other"),
      }),
      [],
    );
    assert.deepStrictEqual(
      yield* service.listInvolving({
        threadIds: [ThreadId.make("thread:critic")],
        participantIds: [],
      }),
      [first],
    );
    assert.deepStrictEqual(
      yield* service.listInvolving({ threadIds: [], participantIds: [captain] }),
      [first],
    );
    assert.deepStrictEqual(
      yield* service.listInvolving({
        threadIds: [ThreadId.make("thread:unrelated")],
        participantIds: [ParticipantId.make("agent:j5:a2a:other")],
      }),
      [],
    );
    yield* service.markArchived(input.id, "2026-09-09T17:00:00.000Z");
    yield* service.markArchived(input.id, "2026-09-09T18:00:00.000Z");
    assert.equal((yield* service.read(input.id))?.archivedAt, "2026-09-09T17:00:00.000Z");
    // A retired Crew's seat is a plain agent again: it may spawn, propose, and be archived alone.
    assert.isNull(yield* service.findMembership(input.members[1]!.participantId));
  }).pipe(Effect.provide(testLayer)),
);

it.effect("decides concurrent additions inside one transaction so the cap holds", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const squadronId = SquadronId.make("squadron:crew-cap");
    yield* (yield* A2ALedger).createSquadron({
      squadron: { id: squadronId, name: "Cap Squadron", createdAt },
    });
    const service = yield* AgentCrewInstanceService;
    const seat = (name: string) => ({
      seatName: name,
      agentId: "scout",
      participantId: ParticipantId.make(`agent:j5:a2a:thread:${name}`),
      threadId: ThreadId.make(`thread:${name}`),
      reason: null,
    });
    const instance = yield* service.record({
      id: "crew:cap",
      squadronId,
      captainParticipantId: ParticipantId.make("agent:j5:a2a:captain-cap"),
      captainThreadId: ThreadId.make("thread:captain-cap"),
      displayName: "Nearly Full",
      brief: "Fill up.",
      createdAt,
      members: Array.from({ length: 11 }, (_, index) => seat(`s${index}`)),
    });
    assert.lengthOf(instance.members, 11);
    // Two approvals landing together: exactly one may take the twelfth seat.
    const [left, right] = yield* Effect.all(
      [
        service.addMembers("crew:cap", [seat("left")], { maxSeats: 12 }),
        service.addMembers("crew:cap", [seat("right")], { maxSeats: 12 }),
      ],
      { concurrency: "unbounded" },
    );
    assert.sameMembers([left.status, right.status], ["added", "cap-exceeded"]);
    const after = (yield* service.read("crew:cap"))!;
    assert.lengthOf(after.members, 12);
    assert.equal(after.version, 2);
    assert.equal(new Set(after.members.map((member) => member.addedVersion)).size, 2);
    // Ordinals stay unique because the base was decided under the same transaction.
    const ordinals = yield* (yield* SqlClient.SqlClient)<{ readonly unique_ordinals: number }>`
      SELECT COUNT(DISTINCT ordinal) AS unique_ordinals FROM j5_agent_crew_member
      WHERE crew_instance_id = 'crew:cap'
    `;
    assert.equal(Number(ordinals[0]?.unique_ordinals), 12);
    // Replaying the winner is idempotent and never counts against the cap again.
    const replay = yield* service.addMembers(
      "crew:cap",
      [seat(left.status === "added" ? "left" : "right")],
      { maxSeats: 12 },
    );
    assert.equal(replay.status, "added");
    assert.equal(replay.instance?.version, 2);
  }).pipe(Effect.provide(testLayer)),
);
