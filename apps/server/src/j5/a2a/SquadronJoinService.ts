import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
  A2AHomeConflictError,
  A2AHomeRegistrationTransaction,
  type A2AHomeRegistrationError,
  type RegisteredThreadHome,
  resolveThreadHome,
} from "./HomeRegistrar.ts";
import { A2ALedgerTransactionWriter } from "./LedgerService.ts";
import {
  ParticipantPlacementService,
  ParticipantPlacementTransactionWriter,
  type PlacementError,
} from "./PlacementService.ts";
import {
  SquadronProjectReferences,
  type SquadronProjectReferenceError,
} from "./SquadronProjectReferences.ts";
import type { CommCommandId, SquadronId } from "./contracts.ts";
import type { ParticipantPlacement, PlacementCommandId } from "./placementContracts.ts";

export interface JoinSquadronInput {
  readonly homeCommandId: CommCommandId;
  readonly placementCommandId: PlacementCommandId;
  readonly squadronId: SquadronId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly joinedAt: string;
}

export interface JoinSquadronResult {
  readonly home: RegisteredThreadHome;
  readonly placement: ParticipantPlacement;
}

export class SquadronJoinProjectReferenceError extends Schema.TaggedErrorClass<SquadronJoinProjectReferenceError>()(
  "SquadronJoinProjectReferenceError",
  {
    squadronId: Schema.String,
    projectId: Schema.String,
    referencedProjectIds: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const referenced =
      this.referencedProjectIds.length === 0 ? "no project" : this.referencedProjectIds.join(", ");
    return `Squadron ${this.squadronId} references ${referenced}, not exactly this thread's project ${this.projectId}. Call list_squadrons and retry join_squadron with a Squadron that references exactly this thread's project.`;
  }
}

export class SquadronJoinRetiredError extends Schema.TaggedErrorClass<SquadronJoinRetiredError>()(
  "SquadronJoinRetiredError",
  { threadId: Schema.String, squadronId: Schema.String, participantId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was retired from Squadron ${this.squadronId} as ${this.participantId}; join_squadron cannot revive a retired participant. The operation is refused.`;
  }
}

export class SquadronJoinHomeStateError extends Schema.TaggedErrorClass<SquadronJoinHomeStateError>()(
  "SquadronJoinHomeStateError",
  {
    threadId: Schema.String,
    squadronId: Schema.String,
    participantId: Schema.String,
    activeHomes: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} has immutable home ${this.squadronId}/${this.participantId}, but its active membership is ${this.activeHomes.length === 0 ? "missing" : this.activeHomes.join(", ")}. Ask the human to repair the membership projection; join_squadron cannot rewrite it.`;
  }
}

export type SquadronJoinError =
  | SquadronJoinProjectReferenceError
  | SquadronJoinRetiredError
  | SquadronJoinHomeStateError
  | A2AHomeConflictError
  | A2AHomeRegistrationError
  | SquadronProjectReferenceError
  | PlacementError
  | SqlError;

export interface SquadronJoinServiceShape {
  /**
   * Gives an existing thread with no home its original home in one explicitly
   * selected Squadron. The thread itself is untouched: this appends the same
   * `participant.joined` and placement facts a sanctioned creation path would
   * have recorded, nothing else.
   */
  readonly joinExistingThread: (
    input: JoinSquadronInput,
  ) => Effect.Effect<JoinSquadronResult, SquadronJoinError>;
}

/**
 * The agent-invocable repair path for native threads that were created without
 * a Squadron. It never selects, moves, or revives a home: an existing home in
 * the requested Squadron is returned as-is, any other home is refused.
 */
export class SquadronJoinService extends Context.Service<
  SquadronJoinService,
  SquadronJoinServiceShape
>()("t3/j5/a2a/SquadronJoinService") {}

export const layer: Layer.Layer<
  SquadronJoinService,
  never,
  | A2AHomeRegistrationTransaction
  | A2ALedgerTransactionWriter
  | ParticipantPlacementService
  | ParticipantPlacementTransactionWriter
  | SquadronProjectReferences
  | SqlClient.SqlClient
> = Layer.effect(
  SquadronJoinService,
  Effect.gen(function* () {
    const homes = yield* A2AHomeRegistrationTransaction;
    const ledgerWriter = yield* A2ALedgerTransactionWriter;
    const placementReads = yield* ParticipantPlacementService;
    const placements = yield* ParticipantPlacementTransactionWriter;
    const projectReferences = yield* SquadronProjectReferences;
    const sql = yield* SqlClient.SqlClient;

    const requireProjectReference = Effect.fn("j5.a2a.join.requireProjectReference")(function* (
      input: JoinSquadronInput,
    ) {
      const references = yield* projectReferences.listForSquadron(input.squadronId);
      const referencedProjectIds = references.map((reference) => reference.projectId);
      if (referencedProjectIds.length !== 1 || referencedProjectIds[0] !== input.projectId) {
        return yield* new SquadronJoinProjectReferenceError({
          squadronId: input.squadronId,
          projectId: input.projectId,
          referencedProjectIds,
        });
      }
    });

    // A natively created thread registered at launch has a home but no
    // placement row. Joining records the same truthful root placement either
    // way, so the directory never shows this participant as unrecorded.
    const ensurePlacement = Effect.fn("j5.a2a.join.ensurePlacement")(function* (
      input: JoinSquadronInput,
      home: RegisteredThreadHome,
    ) {
      const existing = yield* placementReads.readPlacement({
        squadronId: home.squadronId,
        participantId: home.participantId,
      });
      if (existing !== null) return existing;
      const recorded = yield* placements.recordCreationInTransaction({
        commandId: input.placementCommandId,
        squadronId: home.squadronId,
        participantId: home.participantId,
        actor: "agent",
        provenance: { kind: "unknown", source: "native_or_unobserved" },
        createdAt: input.joinedAt,
      });
      return recorded.placement;
    });

    // Same lock order as SpawnCompositionService: appendPermit ≺ mutationPermit
    // ≺ DB, never the delivery drain permit. Holding appendPermit across the
    // home read makes concurrent retries with different command ids serialize:
    // the second sees the first's committed home and appends nothing.
    const joinExistingThread: SquadronJoinServiceShape["joinExistingThread"] = (input) =>
      ledgerWriter.withPermit(
        placements.withPermit(
          sql
            .withTransaction(
              Effect.gen(function* () {
                const existing = yield* resolveThreadHome(sql, input.threadId).pipe(
                  Effect.catchTag("A2AHomeNotFoundError", () => Effect.succeed(null)),
                );
                if (existing !== null) {
                  if (existing.home.squadronId !== input.squadronId) {
                    return yield* new A2AHomeConflictError({
                      threadId: input.threadId,
                      existingSquadronId: existing.home.squadronId,
                      requestedSquadronId: input.squadronId,
                    });
                  }
                  if (existing.retired) {
                    return yield* new SquadronJoinRetiredError({
                      threadId: input.threadId,
                      squadronId: existing.home.squadronId,
                      participantId: existing.home.participantId,
                    });
                  }
                  const activeHome = existing.activeMemberships.filter(
                    (membership) =>
                      membership.squadronId === existing.home.squadronId &&
                      membership.participantId === existing.home.participantId,
                  );
                  if (existing.activeMemberships.length !== 1 || activeHome.length !== 1) {
                    return yield* new SquadronJoinHomeStateError({
                      threadId: input.threadId,
                      squadronId: existing.home.squadronId,
                      participantId: existing.home.participantId,
                      activeHomes: existing.activeMemberships.map(
                        (membership) => `${membership.squadronId}/${membership.participantId}`,
                      ),
                    });
                  }
                  const placement = yield* ensurePlacement(input, existing.home);
                  return { home: existing.home, placement, committedEvents: [] };
                }
                yield* requireProjectReference(input);
                const registered = yield* homes.registerAtCreationInTransaction({
                  commandId: input.homeCommandId,
                  squadronId: input.squadronId,
                  threadId: input.threadId,
                  createdAt: input.joinedAt,
                });
                const placement = yield* ensurePlacement(input, registered.home);
                return {
                  home: registered.home,
                  placement,
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

    return SquadronJoinService.of({ joinExistingThread });
  }),
);
