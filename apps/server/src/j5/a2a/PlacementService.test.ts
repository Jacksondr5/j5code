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
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import {
  PlacementCycleError,
  PlacementGraphCorruptError,
  PlacementHumanRequiredError,
  ParticipantPlacementService,
  layer as placementLayer,
} from "./PlacementService.ts";
import { runPlacementCascade } from "./PlacementCascadeService.ts";
import { CommCommandId, EpicId, ParticipantId, type Participant } from "./contracts.ts";
import {
  PlacementCommandId,
  type ParticipantProvenance,
  type PlacementSelection,
} from "./placementContracts.ts";

const timestamp = "2026-08-16T16:00:00.000Z";
const epicId = EpicId.make("epic:placement");
const isCycle = Schema.is(PlacementCycleError);
const isGraphCorrupt = Schema.is(PlacementGraphCorruptError);
const isHumanRequired = Schema.is(PlacementHumanRequiredError);
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
  source: "j5_wrapper",
});

const joinParticipant = (index: number, participant: Participant) =>
  Effect.gen(function* () {
    const ledger = yield* A2ALedger;
    yield* ledger.append({
      commandId: CommCommandId.make(`membership:${index}`),
      epicId,
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
    yield* ledger.createEpic({
      epic: { id: epicId, name: "Placement tests", createdAt: timestamp },
    });
    for (const [index, participant] of participants.entries()) {
      yield* joinParticipant(index + 1, participant);
    }
  });

const record = (input: {
  readonly index: number;
  readonly participant: Extract<Participant, { kind: "agent" }>;
  readonly provenance: ParticipantProvenance;
  readonly placement?: PlacementSelection;
}) =>
  Effect.gen(function* () {
    const placements = yield* ParticipantPlacementService;
    return yield* placements.recordCreation({
      commandId: PlacementCommandId.make(`placement:${input.index}`),
      epicId,
      participantId: input.participant.id,
      actor: "platform",
      provenance: input.provenance,
      placement: input.placement ?? { type: "default" },
      createdAt: timestamp,
    });
  });

it.effect("keeps sibling placement distinct from immutable spawned-by provenance", () =>
  Effect.gen(function* () {
    const coordinator = agent("coordinator");
    const spawner = agent("spawner");
    const sibling = agent("sibling");
    const explicit = agent("explicit");
    const root = agent("root");
    yield* prepare([coordinator, spawner, sibling, explicit, root]);

    yield* record({
      index: 1,
      participant: coordinator,
      provenance: { kind: "unknown", source: "native_or_unobserved" },
    });
    yield* record({ index: 2, participant: spawner, provenance: spawnedBy(coordinator) });
    const siblingResult = yield* record({
      index: 3,
      participant: sibling,
      provenance: spawnedBy(spawner),
      placement: { type: "sibling" },
    });
    const explicitResult = yield* record({
      index: 4,
      participant: explicit,
      provenance: spawnedBy(spawner),
      placement: { type: "other_parent", parentParticipantId: coordinator.id },
    });
    const rootResult = yield* record({
      index: 5,
      participant: root,
      provenance: spawnedBy(spawner),
      placement: { type: "root" },
    });

    assert.deepStrictEqual(siblingResult.placement.provenance, spawnedBy(spawner));
    assert.equal(siblingResult.placement.placementParentId, coordinator.id);
    assert.equal(explicitResult.placement.placementParentId, coordinator.id);
    assert.equal(rootResult.placement.placementParentId, null);
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
        epicId,
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
        epicId,
        participantId: source.id,
        placementParentId: null,
        createdAt: timestamp,
      });
      assert.equal(
        (yield* placements.readPlacement({ epicId, participantId: nestedFork.id }))
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

      const rows = yield* placements.listParticipants(epicId);
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
      epicId,
      participantId: child.id,
      actor: "agent" as const,
      provenance: spawnedBy(parent),
      placement: { type: "default" as const },
      createdAt: timestamp,
    };

    const first = yield* placements.recordCreation(input);
    const replay = yield* placements.recordCreation(input);

    assert.isTrue(first.committed);
    assert.isFalse(replay.committed);
    assert.deepStrictEqual(replay.event, first.event);
    assert.deepStrictEqual(replay.placement.provenance, spawnedBy(parent));
    assert.lengthOf(yield* placements.listEvents(epicId), 2);
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

      const beforeAgentAttempt = (yield* placements.listEvents(epicId)).length;
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
            epicId,
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
      assert.equal((yield* placements.listEvents(epicId)).length, beforeAgentAttempt);

      const bearerError = yield* Effect.flip(
        placements.reparent(bearerCaller, {
          commandId: PlacementCommandId.make("reparent:bearer-refused"),
          epicId,
          participantId: second.id,
          placementParentId: null,
          createdAt: timestamp,
        }),
      );
      assert.isTrue(isHumanRequired(bearerError));
      assert.include(bearerError.message, "bearer-access-token");
      assert.include(bearerError.message, bearerCaller.principal.subject);
      assert.equal((yield* placements.listEvents(epicId)).length, beforeAgentAttempt);

      const cycleError = yield* Effect.flip(
        placements.reparent(humanCaller, {
          commandId: PlacementCommandId.make("reparent:cycle-refused"),
          epicId,
          participantId: first.id,
          placementParentId: third.id,
          createdAt: timestamp,
        }),
      );
      assert.isTrue(isCycle(cycleError));
      assert.include(cycleError.message, "Placement cycle state");
      assert.equal(
        (yield* placements.readPlacement({ epicId, participantId: first.id }))?.placementParentId,
        null,
      );
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
      WHERE epic_id = ${epicId} AND participant_id IN (${first.id}, ${second.id})
    `;
    const placements = yield* ParticipantPlacementService;

    const mutationError = yield* Effect.flip(
      placements.reparent(humanCaller, {
        commandId: PlacementCommandId.make("reparent:corrupt-graph"),
        epicId,
        participantId: target.id,
        placementParentId: first.id,
        createdAt: timestamp,
      }),
    );
    assert.isTrue(isGraphCorrupt(mutationError));
    assert.include(mutationError.message, "Placement graph state");

    const traversalError = yield* Effect.flip(
      placements.listSubtree({ epicId, participantId: first.id }),
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
      placement: { type: "other_parent", parentParticipantId: secondRoot.id },
    });
    yield* record({ index: 4, participant: childOfMoved, provenance: spawnedBy(movedToSecond) });
    yield* record({
      index: 5,
      participant: movedToFirst,
      provenance: spawnedBy(secondRoot),
      placement: { type: "other_parent", parentParticipantId: firstRoot.id },
    });
    const placements = yield* ParticipantPlacementService;

    const firstCascade = yield* runPlacementCascade({
      placement: placements,
      epicId,
      participantId: firstRoot.id,
      operation: (participant) => Effect.succeed(participant.participantId),
    });
    const secondCascade = yield* runPlacementCascade({
      placement: placements,
      epicId,
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
        epicId,
        participantId: child.id,
        placementParentId: null,
        createdAt: timestamp,
      });
      const childBefore = yield* placements.readPlacement({ epicId, participantId: child.id });
      const parentBefore = yield* placements.readPlacement({ epicId, participantId: parent.id });
      assert.isNotNull(childBefore);
      assert.isNotNull(parentBefore);
      const before = [childBefore!, parentBefore!];
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM j5_a2a_participant_placement WHERE epic_id = ${epicId}`;
      assert.equal(yield* placements.readPlacement({ epicId, participantId: child.id }), null);
      const rebuilt = yield* placements.rebuildProjection(epicId);
      assert.deepStrictEqual(rebuilt, before);
    }).pipe(Effect.provide(TestLayer)),
);
