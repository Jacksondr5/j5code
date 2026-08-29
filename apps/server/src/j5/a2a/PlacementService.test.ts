import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import {
  PlacementCycleError,
  PlacementGraphCorruptError,
  PlacementHumanRequiredError,
  PlacementHumanTargetError,
  PlacementLegacyRepairTargetError,
  PlacementParentIneligibleError,
  PlacementParentNotFoundError,
  PlacementParticipantNotFoundError,
  ParticipantPlacementService,
  layer as placementLayer,
  repairLegacyParticipantPlacement,
} from "./PlacementService.ts";
import { runPlacementCascade } from "./PlacementCascadeService.ts";
import { CommCommandId, SquadronId, ParticipantId, type Participant } from "./contracts.ts";
import {
  PlacementCommandId,
  PlacementReparentedEvent,
  type ParticipantProvenance,
} from "./placementContracts.ts";

const timestamp = "2026-08-16T16:00:00.000Z";
const squadronId = SquadronId.make("squadron:placement");
const legacyGlobalHumanId = ParticipantId.make("human:global");
const isCycle = Schema.is(PlacementCycleError);
const isGraphCorrupt = Schema.is(PlacementGraphCorruptError);
const isHumanRequired = Schema.is(PlacementHumanRequiredError);
const isHumanTarget = Schema.is(PlacementHumanTargetError);
const isLegacyRepairTarget = Schema.is(PlacementLegacyRepairTargetError);
const isParentIneligible = Schema.is(PlacementParentIneligibleError);
const isParentNotFound = Schema.is(PlacementParentNotFoundError);
const isParticipantNotFound = Schema.is(PlacementParticipantNotFoundError);
const humanPrincipal = {
  sessionId: AuthSessionId.make("session:placement-human"),
  subject: "human:placement-test",
  method: "browser-session-cookie" as const,
  scopes: new Set<AuthEnvironmentScope>(),
};
const humanCaller = { kind: "environment", principal: humanPrincipal } as const;
const bearerCaller = {
  kind: "environment",
  principal: {
    ...humanPrincipal,
    sessionId: AuthSessionId.make("session:placement-bearer"),
    subject: "automation:placement-test",
    method: "bearer-access-token" as const,
  },
} as const;

it("accepts only browser-session-cookie authentication on reparent events", () => {
  const isReparentedEvent = Schema.is(PlacementReparentedEvent);
  const event = {
    seq: 1,
    commandId: PlacementCommandId.make("reparent:auth-contract"),
    squadronId,
    participantId: ParticipantId.make("agent:auth-contract"),
    kind: "participant.reparented",
    actor: "human",
    actorSessionId: AuthSessionId.make("session:auth-contract"),
    actorSubject: "human:auth-contract",
    provenance: null,
    previousParentId: null,
    placementParentId: null,
    createdAt: timestamp,
  } as const;

  assert.isTrue(isReparentedEvent({ ...event, authMethod: "browser-session-cookie" }));
  assert.isFalse(isReparentedEvent({ ...event, authMethod: "bearer-access-token" }));
});

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
      const humanReparent = yield* placements.reparent(humanCaller, {
        commandId: PlacementCommandId.make("reparent:source-under-group"),
        squadronId,
        participantId: source.id,
        placementParentId: group.id,
        createdAt: timestamp,
      });
      assert.equal(humanReparent.event.kind, "participant.reparented");
      if (humanReparent.event.kind === "participant.reparented") {
        assert.equal(humanReparent.event.actorSessionId, humanPrincipal.sessionId);
        assert.equal(humanReparent.event.actorSubject, humanPrincipal.subject);
        assert.equal(humanReparent.event.authMethod, humanPrincipal.method);
      }
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

      yield* placements.reparent(humanCaller, {
        commandId: PlacementCommandId.make("reparent:source-to-root"),
        squadronId,
        participantId: source.id,
        placementParentId: null,
        createdAt: timestamp,
      });
      assert.equal(
        (yield* placements.readPlacement({ squadronId, participantId: nestedFork.id }))
          ?.placementParentId,
        group.id,
      );
      const forkReparent = yield* placements.reparent(humanCaller, {
        commandId: PlacementCommandId.make("reparent:fork-to-root"),
        squadronId,
        participantId: nestedFork.id,
        placementParentId: null,
        createdAt: timestamp,
      });
      assert.equal(forkReparent.placement.placementParentId, null);
      assert.deepStrictEqual(forkReparent.placement.provenance, {
        kind: "forked-from",
        sourceParticipantId: source.id,
        source: "upstream_lineage",
      });
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

it.effect("repairs only an explicitly registered legacy agent and never repairs on reads", () => {
  const parent = agent("legacy-repair-parent");
  const child = agent("legacy-repair-child");
  const durablePersonId = ParticipantId.make("human:legacy-repair-person");
  let projectionReads = 0;
  const threadLayer = Layer.mock(ThreadManagementService)({
    getThreadProjection: (threadId) =>
      Effect.sync(() => {
        projectionReads += 1;
        assert.equal(threadId, child.threadId);
        return {
          thread: {
            createdAt: timestamp,
            lineage: {
              parentThreadId: parent.threadId,
              relationshipToParent: "subagent",
            },
          },
        } as never;
      }),
  });

  return Effect.gen(function* () {
    yield* prepare([parent, child]);
    yield* (yield* A2ALedger).append({
      commandId: CommCommandId.make("membership:legacy-repair-parent:left"),
      squadronId,
      acceptedAt: timestamp,
      event: {
        kind: "participant.left",
        sender: parent.id,
        receiver: null,
        exchangeId: null,
        correlationId: null,
        payload: { participant: parent },
        createdAt: timestamp,
      },
    });
    const placements = yield* ParticipantPlacementService;

    assert.equal(yield* placements.readPlacement({ squadronId, participantId: child.id }), null);
    assert.deepStrictEqual(
      (yield* placements.listParticipants(squadronId)).find((row) => row.participantId === child.id)
        ?.provenance,
      { kind: "unrecorded" },
    );
    assert.lengthOf(yield* placements.listEvents(squadronId), 0);
    assert.equal(projectionReads, 0);

    const repaired = yield* repairLegacyParticipantPlacement({
      squadronId,
      participantId: child.id,
    });
    assert.isTrue(repaired.repaired);
    assert.deepStrictEqual(repaired.placement.provenance, {
      kind: "spawned-by",
      spawnedByParticipantId: parent.id,
      source: "upstream_lineage",
    });
    assert.equal(repaired.placement.placementParentId, null);

    const replay = yield* repairLegacyParticipantPlacement({
      squadronId,
      participantId: child.id,
    });
    assert.isFalse(replay.repaired);
    assert.deepStrictEqual(replay.placement, repaired.placement);
    assert.equal(projectionReads, 1);
    assert.lengthOf(yield* placements.listEvents(squadronId), 1);

    for (const personId of [legacyGlobalHumanId, durablePersonId]) {
      const error = yield* Effect.flip(
        repairLegacyParticipantPlacement({ squadronId, participantId: personId }),
      );
      assert.isTrue(isLegacyRepairTarget(error));
      assert.include(error.message, "ineligible-non-agent");
      assert.include(error.message, "explicitly registered agent");
    }
    const unregisteredError = yield* Effect.flip(
      repairLegacyParticipantPlacement({
        squadronId,
        participantId: ParticipantId.make("agent:legacy-repair-unregistered"),
      }),
    );
    assert.isTrue(isLegacyRepairTarget(unregisteredError));
    assert.include(unregisteredError.message, "unregistered");
    assert.equal(projectionReads, 1);
    assert.lengthOf(yield* placements.listEvents(squadronId), 1);
  }).pipe(Effect.provide(Layer.merge(TestLayer, threadLayer)));
});

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
    assert.lengthOf(yield* placements.listEvents(squadronId), 2);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "allows human reparenting while refusing cycles and agent callers with state-naming errors",
  () =>
    Effect.gen(function* () {
      const first = agent("first");
      const second = agent("second");
      const third = agent("third");
      yield* prepare([first, second, third]);
      yield* record({
        index: 1,
        participant: first,
        provenance: { kind: "unknown", source: "native_or_unobserved" },
      });
      yield* record({ index: 2, participant: second, provenance: spawnedBy(first) });
      yield* record({ index: 3, participant: third, provenance: spawnedBy(second) });
      const placements = yield* ParticipantPlacementService;

      const beforeAgentAttempt = (yield* placements.listEvents(squadronId)).length;
      const agentScope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:placement-agent"),
        threadId: first.threadId,
        providerSessionId: "provider-session:placement-agent",
        providerInstanceId: ProviderInstanceId.make("codexAgent"),
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const agentError = yield* Effect.flip(
        placements.reparent(
          { kind: "mcp", scope: agentScope },
          {
            commandId: PlacementCommandId.make("reparent:agent-refused"),
            squadronId,
            participantId: second.id,
            placementParentId: null,
            createdAt: timestamp,
          },
        ),
      );
      assert.isTrue(isHumanRequired(agentError));
      assert.include(agentError.message, "Placement actor state is mcp-agent");
      assert.include(agentError.message, agentScope.providerSessionId);
      assert.include(agentError.message, agentScope.threadId);
      assert.equal((yield* placements.listEvents(squadronId)).length, beforeAgentAttempt);

      const bearerError = yield* Effect.flip(
        placements.reparent(bearerCaller, {
          commandId: PlacementCommandId.make("reparent:bearer-refused"),
          squadronId,
          participantId: second.id,
          placementParentId: null,
          createdAt: timestamp,
        }),
      );
      assert.isTrue(isHumanRequired(bearerError));
      assert.include(bearerError.message, "bearer-access-token");
      assert.include(bearerError.message, bearerCaller.principal.subject);
      assert.equal((yield* placements.listEvents(squadronId)).length, beforeAgentAttempt);

      const cycleError = yield* Effect.flip(
        placements.reparent(humanCaller, {
          commandId: PlacementCommandId.make("reparent:cycle-refused"),
          squadronId,
          participantId: first.id,
          placementParentId: third.id,
          createdAt: timestamp,
        }),
      );
      assert.isTrue(isCycle(cycleError));
      assert.include(cycleError.message, "Placement cycle state");
      assert.equal(
        (yield* placements.readPlacement({ squadronId, participantId: first.id }))
          ?.placementParentId,
        null,
      );
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("refuses human targets and both human parent id shapes as agent-ineligible", () =>
  Effect.gen(function* () {
    const parent = agent("eligible-parent");
    const child = agent("human-parent-child");
    const durablePersonId = ParticipantId.make("human:placement-person");
    yield* prepare([parent, child]);
    const placements = yield* ParticipantPlacementService;

    yield* record({
      index: 1,
      participant: parent,
      provenance: { kind: "unknown", source: "native_or_unobserved" },
    });
    yield* record({
      index: 2,
      participant: child,
      provenance: { kind: "unknown", source: "native_or_unobserved" },
    });

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

      const parentError = yield* Effect.flip(
        placements.reparent(humanCaller, {
          commandId: PlacementCommandId.make(`reparent:human-parent-refused:${index}`),
          squadronId,
          participantId: child.id,
          placementParentId: personId,
          createdAt: timestamp,
        }),
      );
      assert.isTrue(isParentIneligible(parentError));
      assert.include(parentError.message, "ineligible-non-agent");
      assert.include(parentError.message, "Placement parents are agent-only");
      assert.include(parentError.message, personId);
    }

    const reparentTargetError = yield* Effect.flip(
      placements.reparent(humanCaller, {
        commandId: PlacementCommandId.make("reparent:human-target-refused"),
        squadronId,
        participantId: legacyGlobalHumanId,
        placementParentId: null,
        createdAt: timestamp,
      }),
    );
    assert.isTrue(isHumanTarget(reparentTargetError));
    assert.include(reparentTargetError.message, "reparent");
    assert.equal(
      (yield* placements.readPlacement({ squadronId, participantId: child.id }))?.placementParentId,
      null,
    );
    assert.lengthOf(yield* placements.listEvents(squadronId), 2);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("detects corrupt stored cycles in mutation and subtree traversal", () =>
  Effect.gen(function* () {
    const first = agent("corrupt-first");
    const second = agent("corrupt-second");
    const target = agent("corrupt-target");
    yield* prepare([first, second, target]);
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
    yield* record({
      index: 3,
      participant: target,
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
      placements.reparent(humanCaller, {
        commandId: PlacementCommandId.make("reparent:corrupt-graph"),
        squadronId,
        participantId: target.id,
        placementParentId: first.id,
        createdAt: timestamp,
      }),
    );
    assert.isTrue(isGraphCorrupt(mutationError));
    assert.include(mutationError.message, "Placement graph state");

    const traversalError = yield* Effect.flip(
      placements.listSubtree({ squadronId, participantId: first.id }),
    );
    assert.isTrue(isGraphCorrupt(traversalError));
    assert.include(traversalError.message, "Placement graph state");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("walks cascade targets by mutable placement rather than provenance", () =>
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
    yield* placements.reparent(humanCaller, {
      commandId: PlacementCommandId.make("reparent:moved-to-second"),
      squadronId,
      participantId: movedToSecond.id,
      placementParentId: secondRoot.id,
      createdAt: timestamp,
    });
    yield* placements.reparent(humanCaller, {
      commandId: PlacementCommandId.make("reparent:moved-to-first"),
      squadronId,
      participantId: movedToFirst.id,
      placementParentId: firstRoot.id,
      createdAt: timestamp,
    });

    const firstCascade = yield* runPlacementCascade({
      placement: placements,
      squadronId,
      participantId: firstRoot.id,
      operation: (participant) => Effect.succeed(participant.participantId),
    });
    const secondCascade = yield* runPlacementCascade({
      placement: placements,
      squadronId,
      participantId: secondRoot.id,
      operation: (participant) => Effect.succeed(participant.participantId),
    });

    assert.deepStrictEqual(firstCascade, [movedToFirst.id, firstRoot.id]);
    assert.deepStrictEqual(secondCascade, [childOfMoved.id, movedToSecond.id, secondRoot.id]);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "rebuilds the mutable placement projection byte-equivalently from append-only events",
  () =>
    Effect.gen(function* () {
      const parent = agent("rebuild-parent");
      const child = agent("rebuild-child");
      yield* prepare([parent, child]);
      yield* record({
        index: 1,
        participant: parent,
        provenance: { kind: "unknown", source: "native_or_unobserved" },
      });
      yield* record({ index: 2, participant: child, provenance: spawnedBy(parent) });
      const placements = yield* ParticipantPlacementService;
      yield* placements.reparent(humanCaller, {
        commandId: PlacementCommandId.make("reparent:rebuild-child"),
        squadronId,
        participantId: child.id,
        placementParentId: null,
        createdAt: timestamp,
      });
      const childBefore = yield* placements.readPlacement({ squadronId, participantId: child.id });
      const parentBefore = yield* placements.readPlacement({
        squadronId,
        participantId: parent.id,
      });
      assert.isNotNull(childBefore);
      assert.isNotNull(parentBefore);
      const before = [childBefore!, parentBefore!];
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM j5_a2a_participant_placement WHERE squadron_id = ${squadronId}`;
      assert.equal(yield* placements.readPlacement({ squadronId, participantId: child.id }), null);
      const rebuilt = yield* placements.rebuildProjection(squadronId);
      assert.deepStrictEqual(rebuilt, before);
    }).pipe(Effect.provide(TestLayer)),
);
