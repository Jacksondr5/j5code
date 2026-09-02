import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import {
  A2AArchiveFacts,
  A2AArchivePlacementFactsProviderError,
  A2AArchivePlacementFactsProvider,
  layer as archiveFactsLayer,
  placementFactsLayer,
} from "./ArchiveFactsService.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { ParticipantPlacementService, layer as placementLayer } from "./PlacementService.ts";
import { PlacementCommandId } from "./placementContracts.ts";
import {
  CommCommandId,
  ExchangeId,
  ParticipantId,
  SquadronId,
  type AgentParticipant,
} from "./contracts.ts";

const timestamp = "2026-08-29T12:00:00.000Z";
const squadronId = SquadronId.make("squadron:archive-facts");
const participant: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:archive-facts:subject"),
  threadId: ThreadId.make("thread:archive-facts:subject"),
};
const outboundCounterparty: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:archive-facts:outbound"),
  threadId: ThreadId.make("thread:archive-facts:outbound"),
};
const inboundCounterparty: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:archive-facts:inbound"),
  threadId: ThreadId.make("thread:archive-facts:inbound"),
};

const makeTestLayer = (placementFacts = placementFactsLayer) => {
  const database = NodeSqliteClient.layerMemory();
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const placements = placementLayer.pipe(Layer.provide(ledger), Layer.provide(database));
  const facts = archiveFactsLayer.pipe(
    Layer.provide(placementFacts),
    Layer.provide(placements),
    Layer.provide(database),
  );
  return Layer.mergeAll(database, ledger, placements, facts);
};

const seed = Effect.gen(function* () {
  yield* runJ5A2AMigrations();
  const ledger = yield* A2ALedger;
  yield* ledger.createSquadron({
    squadron: { id: squadronId, name: "Archive facts", createdAt: timestamp },
  });
  for (const [index, candidate] of [
    participant,
    outboundCounterparty,
    inboundCounterparty,
  ].entries()) {
    yield* ledger.append({
      commandId: CommCommandId.make(`command:archive-facts:join:${index}`),
      squadronId,
      acceptedAt: timestamp,
      event: {
        kind: "participant.joined",
        sender: null,
        receiver: candidate.id,
        exchangeId: null,
        correlationId: null,
        payload: { participant: candidate },
        createdAt: timestamp,
      },
    });
  }
  yield* ledger.append({
    commandId: CommCommandId.make("command:archive-facts:outbound"),
    squadronId,
    acceptedAt: timestamp,
    event: {
      kind: "exchange.opened",
      sender: participant.id,
      receiver: outboundCounterparty.id,
      exchangeId: ExchangeId.make("exchange:archive-facts:outbound"),
      correlationId: null,
      payload: { intent: "Wait for a counterparty", urgency: "soon" },
      createdAt: "2026-08-29T12:00:01.000Z",
    },
  });
  yield* ledger.append({
    commandId: CommCommandId.make("command:archive-facts:inbound"),
    squadronId,
    acceptedAt: timestamp,
    event: {
      kind: "exchange.opened",
      sender: inboundCounterparty.id,
      receiver: participant.id,
      exchangeId: ExchangeId.make("exchange:archive-facts:inbound"),
      correlationId: null,
      payload: { intent: "Reply before retiring", urgency: "blocking" },
      createdAt: "2026-08-29T12:00:02.000Z",
    },
  });
  yield* ledger.append({
    commandId: CommCommandId.make("command:archive-facts:unrelated"),
    squadronId,
    acceptedAt: timestamp,
    event: {
      kind: "exchange.opened",
      sender: inboundCounterparty.id,
      receiver: outboundCounterparty.id,
      exchangeId: ExchangeId.make("exchange:archive-facts:unrelated"),
      correlationId: null,
      payload: { intent: "Unrelated work", urgency: null },
      createdAt: "2026-08-29T12:00:03.000Z",
    },
  });
});

it.effect("reports open exchanges in both directions and a checked-empty placement subtree", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const before = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM j5_a2a_comm_event
    `;
    const facts = yield* (yield* A2AArchiveFacts).readForThread(participant.threadId);
    const after = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM j5_a2a_comm_event
    `;

    assert.equal(facts.state, "registered");
    if (facts.state !== "registered") return;
    assert.deepStrictEqual(
      facts.openExchanges.map((exchange) => ({
        exchangeId: exchange.exchangeId,
        direction: exchange.direction,
        replyObligation: exchange.replyObligation,
        counterpartyId: exchange.counterpartyId,
      })),
      [
        {
          exchangeId: "exchange:archive-facts:outbound",
          direction: "outbound",
          replyObligation: "counterparty-owes-reply",
          counterpartyId: outboundCounterparty.id,
        },
        {
          exchangeId: "exchange:archive-facts:inbound",
          direction: "inbound",
          replyObligation: "participant-owes-reply",
          counterpartyId: inboundCounterparty.id,
        },
      ],
    );
    assert.deepStrictEqual(facts.placementSubtree, { state: "none" });
    assert.deepStrictEqual(after, before);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("reports real placement descendants without including the archived root", () =>
  Effect.gen(function* () {
    yield* seed;
    const placements = yield* ParticipantPlacementService;
    yield* placements.recordCreation({
      commandId: PlacementCommandId.make("command:archive-facts:placement:subject"),
      squadronId,
      participantId: participant.id,
      actor: "platform",
      provenance: { kind: "unknown", source: "native_or_unobserved" },
      createdAt: timestamp,
    });
    yield* placements.recordCreation({
      commandId: PlacementCommandId.make("command:archive-facts:placement:inbound"),
      squadronId,
      participantId: inboundCounterparty.id,
      actor: "platform",
      provenance: {
        kind: "spawned-by",
        spawnedByParticipantId: participant.id,
        source: "j5_spawn",
      },
      createdAt: timestamp,
    });
    const facts = yield* (yield* A2AArchiveFacts).readForThread(participant.threadId);
    assert.equal(facts.state, "registered");
    if (facts.state !== "registered") return;
    assert.deepStrictEqual(facts.placementSubtree, {
      state: "known",
      participantIds: [inboundCounterparty.id],
    });
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect(
  "renders a failed placement lookup as unknown instead of a reassuring empty subtree",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const facts = yield* (yield* A2AArchiveFacts).readForThread(participant.threadId);
      assert.equal(facts.state, "registered");
      if (facts.state !== "registered") return;
      assert.deepStrictEqual(facts.placementSubtree, {
        state: "unknown",
        reason: "placement-query-failed",
      });
    }).pipe(
      Effect.provide(
        makeTestLayer(
          Layer.succeed(
            A2AArchivePlacementFactsProvider,
            A2AArchivePlacementFactsProvider.of({
              readSubtree: () =>
                Effect.fail(
                  new A2AArchivePlacementFactsProviderError({
                    operation: "read placement subtree",
                    cause: "placement store unavailable",
                  }),
                ),
            }),
          ),
        ),
      ),
    ),
);

it.effect("names a native thread as not participating instead of guessing placement", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const threadId = ThreadId.make("thread:archive-facts:native");
    assert.deepStrictEqual(yield* (yield* A2AArchiveFacts).readForThread(threadId), {
      state: "not-an-a2a-participant",
      threadId,
      openExchanges: [],
      placementSubtree: { state: "not-applicable" },
    });
  }).pipe(Effect.provide(makeTestLayer())),
);
