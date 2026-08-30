import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import {
  PlacementGraphCorruptError,
  PlacementHumanTargetError,
  PlacementParentNotFoundError,
  PlacementParticipantNotFoundError,
  ParticipantPlacementService,
  layer as placementLayer,
} from "./PlacementService.ts";
import { CommCommandId, SquadronId, ParticipantId, type Participant } from "./contracts.ts";
import { PlacementCommandId, type ParticipantProvenance } from "./placementContracts.ts";

const timestamp = "2026-08-16T16:00:00.000Z";
const squadronId = SquadronId.make("squadron:placement");
const legacyGlobalHumanId = ParticipantId.make("human:global");
const isGraphCorrupt = Schema.is(PlacementGraphCorruptError);
const isHumanTarget = Schema.is(PlacementHumanTargetError);
const isParentNotFound = Schema.is(PlacementParentNotFoundError);
const isParticipantNotFound = Schema.is(PlacementParticipantNotFoundError);
const TestLayer = Layer.merge(ledgerLayer, placementLayer).pipe(
  Layer.provideMerge(NodeSqliteClient.layerMemory()),
);

const agent = (name: string): Extract<Participant, { kind: "agent" }> => ({
  kind: "agent",
  id: ParticipantId.make(`agent:${name}`),
  threadId: ThreadId.make(`thread:${name}`),
});

const spawnedBy = (participant: Participant): ParticipantProvenance => ({
  kind: "spawned-by",
  spawnedByParticipantId:
    participant.kind === "agent" ? participant.id : ParticipantId.make("human:global"),
  source: "j5_spawn",
});

const joinParticipant = (index: number, participant: Participant) =>
  Effect.gen(function* () {
    const ledger = yield* A2ALedger;
    yield* ledger.append({
      commandId: CommCommandId.make(`membership:${index}`),
      squadronId,
      acceptedAt: timestamp,
      event: {
        kind: "participant.joined",
        sender: null,
        receiver: participant.kind === "agent" ? participant.id : null,
        exchangeId: null,
        correlationId: null,
        payload: { participant },
        createdAt: timestamp,
      },
    });
  });

const prepare = (participants: ReadonlyArray<Participant>) =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const ledger = yield* A2ALedger;
    yield* ledger.createSquadron({
      squadron: { id: squadronId, name: "Placement tests", createdAt: timestamp },
    });
    for (const [index, participant] of participants.entries()) {
      yield* joinParticipant(index + 1, participant);
    }
  });

const record = (input: {
  readonly index: number;
  readonly participant: Extract<Participant, { kind: "agent" }>;
  readonly provenance: ParticipantProvenance;
}) =>
  Effect.gen(function* () {
    const placements = yield* ParticipantPlacementService;
    return yield* placements.recordCreation({
      commandId: PlacementCommandId.make(`placement:${input.index}`),
      squadronId,
      participantId: input.participant.id,
      actor: "platform",
      provenance: input.provenance,
      createdAt: timestamp,
    });
  });

it.effect("places wrapper-created children under their current caller", () =>
  Effect.gen(function* () {
    const spawner = agent("spawner");
    const child = agent("wrapper-child");
    yield* prepare([spawner, child]);

    yield* record({
      index: 1,
      participant: spawner,
      provenance: { kind: "unknown", source: "native_or_unobserved" },
    });
    const childResult = yield* record({
      index: 2,
      participant: child,
      provenance: spawnedBy(spawner),
    });

    assert.deepStrictEqual(childResult.placement.provenance, spawnedBy(spawner));
    assert.equal(childResult.placement.placementParentId, spawner.id);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("places through retained departed ancestors using the placement-row safety bound", () =>
  Effect.gen(function* () {
    const root = agent("departed-chain-root");
    const first = agent("departed-chain-first");
    const second = agent("departed-chain-second");
    const spawner = agent("departed-chain-spawner");
    const child = agent("departed-chain-child");
    yield* prepare([root, first, second, spawner, child]);
    yield* record({
      index: 101,
      participant: root,
      provenance: { kind: "unknown", source: "native_or_unobserved" },
    });
    yield* record({ index: 102, participant: first, provenance: spawnedBy(root) });
    yield* record({ index: 103, participant: second, provenance: spawnedBy(first) });
    yield* record({ index: 104, participant: spawner, provenance: spawnedBy(second) });

    const ledger = yield* A2ALedger;
    for (const participant of [root, first, second]) {
      yield* ledger.append({
        commandId: CommCommandId.make(`membership:${participant.id}:left`),
        squadronId,
        acceptedAt: timestamp,
        event: {
          kind: "participant.left",
          sender: participant.id,
          receiver: null,
          exchangeId: null,
          correlationId: null,
          payload: { participant },
          createdAt: timestamp,
        },
      });
    }

    const result = yield* record({
      index: 105,
      participant: child,
      provenance: spawnedBy(spawner),
    });
    assert.deepStrictEqual(result.placement.provenance, spawnedBy(spawner));
    assert.equal(result.placement.placementParentId, spawner.id);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "types fork provenance without coercing it to spawned-by and defaults forks to source siblings",
  () =>
    Effect.gen(function* () {
      const group = agent("group");
      const source = agent("fork-source");
      const rootFork = agent("fork-root");
      const nestedFork = agent("fork-nested");
      yield* prepare([group, source, rootFork, nestedFork]);
      yield* record({
        index: 1,
        participant: group,
        provenance: { kind: "unknown", source: "native_or_unobserved" },
      });
      yield* record({
        index: 2,
        participant: source,
        provenance: { kind: "unknown", source: "native_or_unobserved" },
      });
      const rootForkResult = yield* record({
        index: 3,
        participant: rootFork,
        provenance: {
          kind: "forked-from",
          sourceParticipantId: source.id,
          source: "upstream_lineage",
        },
      });
      assert.deepStrictEqual(rootForkResult.placement.provenance, {
        kind: "forked-from",
        sourceParticipantId: source.id,
        source: "upstream_lineage",
      });
      assert.notEqual(rootForkResult.placement.provenance.kind, "spawned-by");
      assert.equal(rootForkResult.placement.placementParentId, null);
      assert.notEqual(rootForkResult.placement.placementParentId, source.id);

      const placements = yield* ParticipantPlacementService;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE j5_a2a_participant_placement
        SET placement_parent_id = ${group.id}
        WHERE squadron_id = ${squadronId} AND participant_id = ${source.id}
      `;
      const nestedForkResult = yield* record({
        index: 4,
        participant: nestedFork,
        provenance: {
          kind: "forked-from",
          sourceParticipantId: source.id,
          source: "upstream_lineage",
        },
      });
      assert.equal(nestedForkResult.placement.placementParentId, group.id);

      yield* sql`
        UPDATE j5_a2a_participant_placement
        SET placement_parent_id = NULL
        WHERE squadron_id = ${squadronId} AND participant_id = ${source.id}
      `;
      assert.equal(
        (yield* placements.readPlacement({ squadronId, participantId: nestedFork.id }))
          ?.placementParentId,
        group.id,
      );
    }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "records ordinary creation as unknown and keeps missing placement explicitly unrecorded",
  () =>
    Effect.gen(function* () {
      const native = agent("native");
      const unrecorded = agent("unrecorded");
      yield* prepare([native, unrecorded]);
      yield* record({
        index: 1,
        participant: native,
        provenance: { kind: "unknown", source: "native_or_unobserved" },
      });
      const placements = yield* ParticipantPlacementService;

      const rows = yield* placements.listParticipants(squadronId);
      const nativeRow = rows.find((row) => row.participantId === native.id);
      const unrecordedRow = rows.find((row) => row.participantId === unrecorded.id);
      assert.deepStrictEqual(nativeRow?.provenance, {
        kind: "unknown",
        source: "native_or_unobserved",
      });
      assert.equal(nativeRow?.placementParentId, null);
      assert.notEqual(nativeRow?.provenance.kind, "spawned-by");
      assert.deepStrictEqual(unrecordedRow?.provenance, { kind: "unrecorded" });
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("roots departed lineage backfill while refusing a participant id that never joined", () =>
  Effect.gen(function* () {
    const departedParent = agent("departed-parent");
    const child = agent("departed-child");
    const wrapperChild = agent("departed-wrapper-child");
    const fabricatedTarget = agent("fabricated-target");
    const fabricatedSource = agent("never-joined-source");
    yield* prepare([departedParent, child, wrapperChild, fabricatedTarget]);
    yield* record({
      index: 1,
      participant: departedParent,
      provenance: { kind: "unknown", source: "native_or_unobserved" },
    });
    yield* (yield* A2ALedger).append({
      commandId: CommCommandId.make("membership:departed-parent:left"),
      squadronId,
      acceptedAt: timestamp,
      event: {
        kind: "participant.left",
        sender: departedParent.id,
        receiver: null,
        exchangeId: null,
        correlationId: null,
        payload: { participant: departedParent },
        createdAt: timestamp,
      },
    });

    const departedResult = yield* record({
      index: 2,
      participant: child,
      provenance: {
        kind: "spawned-by",
        spawnedByParticipantId: departedParent.id,
        source: "upstream_lineage",
      },
    });
    assert.deepStrictEqual(departedResult.placement.provenance, {
      kind: "spawned-by",
      spawnedByParticipantId: departedParent.id,
      source: "upstream_lineage",
    });
    assert.equal(departedResult.placement.placementParentId, null);

    const wrapperError = yield* Effect.flip(
      record({
        index: 3,
        participant: wrapperChild,
        provenance: {
          kind: "spawned-by",
          spawnedByParticipantId: departedParent.id,
          source: "j5_spawn",
        },
      }),
    );
    assert.isTrue(isParentNotFound(wrapperError));
    assert.include(wrapperError.message, departedParent.id);
    assert.equal(
      yield* (yield* ParticipantPlacementService).readPlacement({
        squadronId,
        participantId: wrapperChild.id,
      }),
      null,
    );

    const fabricatedError = yield* Effect.flip(
      record({
        index: 4,
        participant: fabricatedTarget,
        provenance: {
          kind: "spawned-by",
          spawnedByParticipantId: fabricatedSource.id,
          source: "upstream_lineage",
        },
      }),
    );
    assert.isTrue(isParticipantNotFound(fabricatedError));
    assert.include(fabricatedError.message, fabricatedSource.id);
    assert.equal(
      yield* (yield* ParticipantPlacementService).readPlacement({
        squadronId,
        participantId: fabricatedTarget.id,
      }),
      null,
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("replays placement creation without changing immutable provenance", () =>
  Effect.gen(function* () {
    const parent = agent("replay-parent");
    const child = agent("replay-child");
    yield* prepare([parent, child]);
    yield* record({
      index: 1,
      participant: parent,
      provenance: { kind: "unknown", source: "native_or_unobserved" },
    });
    const placements = yield* ParticipantPlacementService;
    const input = {
      commandId: PlacementCommandId.make("placement:replay"),
      squadronId,
      participantId: child.id,
      actor: "agent" as const,
      provenance: spawnedBy(parent),
      createdAt: timestamp,
    };

    const first = yield* placements.recordCreation(input);
    const replayProvenance: ParticipantProvenance = {
      source: "j5_spawn",
      spawnedByParticipantId: parent.id,
      kind: "spawned-by",
    };
    const replay = yield* placements.recordCreation({
      ...input,
      provenance: replayProvenance,
    });

    assert.isTrue(first.committed);
    assert.isFalse(replay.committed);
    assert.deepStrictEqual(replay.event, first.event);
    assert.deepStrictEqual(replay.placement.provenance, spawnedBy(parent));
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("refuses both human participant id shapes as immutable placement targets", () =>
  Effect.gen(function* () {
    const durablePersonId = ParticipantId.make("human:placement-person");
    yield* prepare([]);
    const placements = yield* ParticipantPlacementService;

    for (const [index, personId] of [
      [1, legacyGlobalHumanId],
      [2, durablePersonId],
    ] as const) {
      const creationError = yield* Effect.flip(
        placements.recordCreation({
          commandId: PlacementCommandId.make(`placement:human-target-refused:${index}`),
          squadronId,
          participantId: personId,
          actor: "platform",
          provenance: { kind: "unknown", source: "native_or_unobserved" },
          createdAt: timestamp,
        }),
      );
      assert.isTrue(isHumanTarget(creationError));
      assert.include(creationError.message, "immutable-human");
      assert.include(creationError.message, "record-creation");
    }
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("detects corrupt stored cycles in creation and subtree traversal", () =>
  Effect.gen(function* () {
    const first = agent("corrupt-first");
    const second = agent("corrupt-second");
    const child = agent("corrupt-child");
    yield* prepare([first, second, child]);
    yield* record({
      index: 1,
      participant: first,
      provenance: { kind: "unknown", source: "native_or_unobserved" },
    });
    yield* record({
      index: 2,
      participant: second,
      provenance: { kind: "unknown", source: "native_or_unobserved" },
    });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE j5_a2a_participant_placement
      SET placement_parent_id = CASE participant_id
        WHEN ${first.id} THEN ${second.id}
        WHEN ${second.id} THEN ${first.id}
      END
      WHERE squadron_id = ${squadronId} AND participant_id IN (${first.id}, ${second.id})
    `;
    const placements = yield* ParticipantPlacementService;

    const mutationError = yield* Effect.flip(
      record({ index: 3, participant: child, provenance: spawnedBy(first) }),
    );
    assert.isTrue(isGraphCorrupt(mutationError));
    assert.include(mutationError.message, "Placement graph state");
    assert.equal(yield* placements.readPlacement({ squadronId, participantId: child.id }), null);

    const traversalError = yield* Effect.flip(
      placements.listSubtree({ squadronId, participantId: first.id }),
    );
    assert.isTrue(isGraphCorrupt(traversalError));
    assert.include(traversalError.message, "Placement graph state");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("walks the mutable placement subtree leaves-first rather than following provenance", () =>
  Effect.gen(function* () {
    const firstRoot = agent("tree-a-root");
    const secondRoot = agent("tree-b-root");
    const movedToSecond = agent("spawned-by-a-placed-b");
    const childOfMoved = agent("child-of-moved");
    const movedToFirst = agent("spawned-by-b-placed-a");
    yield* prepare([firstRoot, secondRoot, movedToSecond, childOfMoved, movedToFirst]);
    yield* record({
      index: 1,
      participant: firstRoot,
      provenance: { kind: "unknown", source: "native_or_unobserved" },
    });
    yield* record({
      index: 2,
      participant: secondRoot,
      provenance: { kind: "unknown", source: "native_or_unobserved" },
    });
    yield* record({
      index: 3,
      participant: movedToSecond,
      provenance: spawnedBy(firstRoot),
    });
    yield* record({ index: 4, participant: childOfMoved, provenance: spawnedBy(movedToSecond) });
    yield* record({
      index: 5,
      participant: movedToFirst,
      provenance: spawnedBy(secondRoot),
    });
    const placements = yield* ParticipantPlacementService;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE j5_a2a_participant_placement
      SET placement_parent_id = CASE participant_id
        WHEN ${movedToSecond.id} THEN ${secondRoot.id}
        WHEN ${movedToFirst.id} THEN ${firstRoot.id}
        ELSE placement_parent_id
      END
      WHERE squadron_id = ${squadronId}
        AND participant_id IN (${movedToSecond.id}, ${movedToFirst.id})
    `;

    const firstSubtree = yield* placements.listSubtree({
      squadronId,
      participantId: firstRoot.id,
    });
    const secondSubtree = yield* placements.listSubtree({
      squadronId,
      participantId: secondRoot.id,
    });

    assert.deepStrictEqual(
      firstSubtree.map((participant) => participant.participantId),
      [movedToFirst.id, firstRoot.id],
    );
    assert.deepStrictEqual(
      secondSubtree.map((participant) => participant.participantId),
      [childOfMoved.id, movedToSecond.id, secondRoot.id],
    );
  }).pipe(Effect.provide(TestLayer)),
);
