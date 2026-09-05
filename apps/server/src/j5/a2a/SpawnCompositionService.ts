import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
  A2AHomeRegistrationTransaction,
  type A2AHomeRegistrationError,
  type RegisteredThreadHome,
} from "./HomeRegistrar.ts";
import { A2ALedgerTransactionWriter } from "./LedgerService.ts";
import { ParticipantPlacementTransactionWriter, type PlacementError } from "./PlacementService.ts";
import type { CommCommandId, ParticipantId, SquadronId } from "./contracts.ts";
import type { ParticipantPlacement, PlacementCommandId } from "./placementContracts.ts";

export interface RecordSpawnFactsInput {
  readonly homeCommandId: CommCommandId;
  readonly placementCommandId: PlacementCommandId;
  readonly squadronId: SquadronId;
  readonly threadId: ThreadId;
  readonly spawnedByParticipantId: ParticipantId;
  readonly createdAt: string;
}

export interface RecordSpawnFactsResult {
  readonly home: RegisteredThreadHome;
  readonly placement: ParticipantPlacement;
}

export type RecordSpawnFactsError = A2AHomeRegistrationError | PlacementError | SqlError;

export interface SpawnCompositionServiceShape {
  readonly recordFacts: (
    input: RecordSpawnFactsInput,
  ) => Effect.Effect<RecordSpawnFactsResult, RecordSpawnFactsError>;
}

export class SpawnCompositionService extends Context.Service<
  SpawnCompositionService,
  SpawnCompositionServiceShape
>()("t3/j5/a2a/SpawnCompositionService") {}

export const layer: Layer.Layer<
  SpawnCompositionService,
  never,
  | A2AHomeRegistrationTransaction
  | A2ALedgerTransactionWriter
  | ParticipantPlacementTransactionWriter
  | SqlClient.SqlClient
> = Layer.effect(
  SpawnCompositionService,
  Effect.gen(function* () {
    const homes = yield* A2AHomeRegistrationTransaction;
    const ledgerWriter = yield* A2ALedgerTransactionWriter;
    const placements = yield* ParticipantPlacementTransactionWriter;
    const sql = yield* SqlClient.SqlClient;

    // Lifecycle writers share one total lock order:
    // drainPermit ≺ appendPermit ≺ mutationPermit ≺ DB. Spawn never drains: this
    // coordinator never acquires drainPermit, which is private to DeliveryWorker
    // and cannot be held across this call. A delivery drain may be in flight while
    // this runs; it simply contends for appendPermit. If a future lifecycle path
    // exposes and holds a drain permit while composing, it must acquire that
    // permit before appendPermit.
    const recordFacts: SpawnCompositionServiceShape["recordFacts"] = (input) =>
      ledgerWriter.withPermit(
        placements.withPermit(
          sql
            .withTransaction(
              Effect.gen(function* () {
                const registered = yield* homes.registerAtCreationInTransaction({
                  commandId: input.homeCommandId,
                  squadronId: input.squadronId,
                  threadId: input.threadId,
                  createdAt: input.createdAt,
                });
                const placement = yield* placements.recordCreationInTransaction({
                  commandId: input.placementCommandId,
                  squadronId: input.squadronId,
                  participantId: registered.home.participantId,
                  actor: "agent",
                  provenance: {
                    kind: "spawned-by",
                    spawnedByParticipantId: input.spawnedByParticipantId,
                    source: "j5_spawn",
                  },
                  createdAt: input.createdAt,
                });
                return {
                  home: registered.home,
                  placement: placement.placement,
                  committedEvents: registered.committedEvents,
                };
              }),
            )
            .pipe(
              Effect.tap((result) => ledgerWriter.publishCommitted(result.committedEvents)),
              Effect.map(({ home, placement }) => ({ home, placement })),
            ),
        ),
      );

    return SpawnCompositionService.of({ recordFacts });
  }),
);
