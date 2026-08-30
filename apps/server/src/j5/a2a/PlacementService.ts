import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  SquadronId,
  Participant,
  ParticipantId,
  isHumanParticipantId,
  participantId as participantIdOf,
} from "./contracts.ts";
import {
  ParticipantPlacement,
  type ParticipantPlacementView,
  PlacementCommandId,
  PlacementEvent,
  type PlacementMutationResult,
  type RecordParticipantPlacementInput,
} from "./placementContracts.ts";

export class PlacementStorageError extends Schema.TaggedErrorClass<PlacementStorageError>()(
  "PlacementStorageError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class PlacementSquadronNotFoundError extends Schema.TaggedErrorClass<PlacementSquadronNotFoundError>()(
  "PlacementSquadronNotFoundError",
  { squadronId: SquadronId },
) {
  override get message(): string {
    return `Placement squadron state is missing for ${this.squadronId}. Create the squadron before placing participants.`;
  }
}

export class PlacementParticipantNotFoundError extends Schema.TaggedErrorClass<PlacementParticipantNotFoundError>()(
  "PlacementParticipantNotFoundError",
  { squadronId: SquadronId, participantId: ParticipantId },
) {
  override get message(): string {
    return `Placement participant state is missing for ${this.participantId} in squadron ${this.squadronId}. Join the participant before changing placement.`;
  }
}

export class PlacementParentNotFoundError extends Schema.TaggedErrorClass<PlacementParentNotFoundError>()(
  "PlacementParentNotFoundError",
  { squadronId: SquadronId, parentParticipantId: ParticipantId },
) {
  override get message(): string {
    return `Placement parent state is missing for ${this.parentParticipantId} in squadron ${this.squadronId}. Choose an active participant or root.`;
  }
}

export class PlacementParentIneligibleError extends Schema.TaggedErrorClass<PlacementParentIneligibleError>()(
  "PlacementParentIneligibleError",
  { squadronId: SquadronId, parentParticipantId: ParticipantId },
) {
  override get message(): string {
    return `Placement parent state is ineligible-non-agent for ${this.parentParticipantId} in squadron ${this.squadronId}. Placement parents are agent-only; choose an agent participant or root.`;
  }
}

export class PlacementAlreadyExistsError extends Schema.TaggedErrorClass<PlacementAlreadyExistsError>()(
  "PlacementAlreadyExistsError",
  { squadronId: SquadronId, participantId: ParticipantId },
) {
  override get message(): string {
    return `Placement state already exists for ${this.participantId} in squadron ${this.squadronId}; creation cannot rewrite immutable provenance.`;
  }
}

export class PlacementHumanTargetError extends Schema.TaggedErrorClass<PlacementHumanTargetError>()(
  "PlacementHumanTargetError",
  {
    operation: Schema.Literal("record-creation"),
    squadronId: SquadronId,
    participantId: ParticipantId,
  },
) {
  override get message(): string {
    return `Placement participant state is immutable-human for ${this.participantId} in squadron ${this.squadronId}; ${this.operation} only accepts agent participants.`;
  }
}

export class PlacementCycleError extends Schema.TaggedErrorClass<PlacementCycleError>()(
  "PlacementCycleError",
  {
    participantId: ParticipantId,
    requestedParentId: ParticipantId,
    path: Schema.Array(ParticipantId),
  },
) {
  override get message(): string {
    return `Placement cycle state: placing ${this.participantId} under ${this.requestedParentId} would make it its own ancestor through ${this.path.join(" -> ")}. Choose root or a participant outside that subtree.`;
  }
}

export class PlacementGraphCorruptError extends Schema.TaggedErrorClass<PlacementGraphCorruptError>()(
  "PlacementGraphCorruptError",
  { squadronId: SquadronId, path: Schema.Array(ParticipantId) },
) {
  override get message(): string {
    return `Placement graph state is already cyclic or exceeds its membership bound in squadron ${this.squadronId}: ${this.path.join(" -> ")}. Repair the placement projection before retrying.`;
  }
}

export class PlacementCommandConflictError extends Schema.TaggedErrorClass<PlacementCommandConflictError>()(
  "PlacementCommandConflictError",
  { commandId: Schema.String, existingParticipantId: ParticipantId },
) {
  override get message(): string {
    return `Placement command state conflicts for ${this.commandId}; it already belongs to participant ${this.existingParticipantId}. Retry with a new command id.`;
  }
}

export type PlacementError =
  | PlacementStorageError
  | PlacementSquadronNotFoundError
  | PlacementParticipantNotFoundError
  | PlacementParentNotFoundError
  | PlacementParentIneligibleError
  | PlacementAlreadyExistsError
  | PlacementHumanTargetError
  | PlacementCycleError
  | PlacementGraphCorruptError
  | PlacementCommandConflictError;

const PlacementErrorSchema = Schema.Union([
  PlacementStorageError,
  PlacementSquadronNotFoundError,
  PlacementParticipantNotFoundError,
  PlacementParentNotFoundError,
  PlacementParentIneligibleError,
  PlacementAlreadyExistsError,
  PlacementHumanTargetError,
  PlacementCycleError,
  PlacementGraphCorruptError,
  PlacementCommandConflictError,
]);
const isPlacementError = Schema.is(PlacementErrorSchema);

export interface ParticipantPlacementServiceShape {
  /** Imminent A2 spawn/verb slice records placement at agent creation. */
  readonly recordCreation: (
    input: RecordParticipantPlacementInput,
  ) => Effect.Effect<PlacementMutationResult, PlacementError>;
  /** Imminent A2 spawn/verb slice reads the newly recorded placement. */
  readonly readPlacement: (input: {
    readonly squadronId: SquadronId;
    readonly participantId: ParticipantId;
  }) => Effect.Effect<ParticipantPlacement | null, PlacementError>;
  /** Live `list_participants` enrichment read surface. */
  readonly listParticipants: (
    squadronId: SquadronId,
  ) => Effect.Effect<ReadonlyArray<ParticipantPlacementView>, PlacementError>;
  /**
   * Placement descendants in leaves-first order, including the requested root.
   * The in-flight A9 AR2 pre-archive provider is the named consumer.
   */
  readonly listSubtree: (input: {
    readonly squadronId: SquadronId;
    readonly participantId: ParticipantId;
  }) => Effect.Effect<ReadonlyArray<ParticipantPlacementView>, PlacementError>;
}

export class ParticipantPlacementService extends Context.Service<
  ParticipantPlacementService,
  ParticipantPlacementServiceShape
>()("t3/j5/a2a/PlacementService/ParticipantPlacementService") {}

interface EventRow {
  readonly seq: number;
  readonly command_id: string;
  readonly request_fingerprint: string;
  readonly squadron_id: string;
  readonly participant_id: string;
  readonly kind: "participant.placement_created" | "participant.reparented";
  readonly actor: "human" | "agent" | "platform";
  readonly actor_session_id: string | null;
  readonly actor_subject: string | null;
  readonly auth_method: "browser-session-cookie" | null;
  readonly provenance_kind: "spawned-by" | "forked-from" | "unknown" | null;
  readonly provenance_participant_id: string | null;
  readonly provenance_source: "upstream_lineage" | "j5_spawn" | null;
  readonly previous_parent_id: string | null;
  readonly placement_parent_id: string | null;
  readonly created_at: string;
}

interface PlacementRow {
  readonly squadron_id: string;
  readonly participant_id: string;
  readonly provenance_kind: "spawned-by" | "forked-from" | "unknown";
  readonly provenance_participant_id: string | null;
  readonly provenance_source: "upstream_lineage" | "j5_spawn" | null;
  readonly placement_parent_id: string | null;
  readonly created_event_seq: number;
  readonly updated_event_seq: number;
}

interface ParticipantRow {
  readonly payload: string;
  readonly squadron_id: string;
  readonly participant_id: string;
  readonly provenance_kind: "spawned-by" | "forked-from" | "unknown" | null;
  readonly provenance_participant_id: string | null;
  readonly provenance_source: "upstream_lineage" | "j5_spawn" | null;
  readonly placement_parent_id: string | null;
}

const decodeEvent = Schema.decodeUnknownEffect(PlacementEvent);
const decodePlacement = Schema.decodeUnknownEffect(ParticipantPlacement);
const decodeParticipant = Schema.decodeUnknownEffect(Schema.fromJsonString(Participant));

const provenanceFromRow = (row: {
  readonly provenance_kind: "spawned-by" | "forked-from" | "unknown";
  readonly provenance_participant_id: string | null;
  readonly provenance_source: "upstream_lineage" | "j5_spawn" | null;
}) => {
  // The migration CHECKs make the non-null provenance fields exhaustive for
  // each stored kind. Projection decoding intentionally relies on that invariant.
  switch (row.provenance_kind) {
    case "unknown":
      return { kind: "unknown", source: "native_or_unobserved" } as const;
    case "spawned-by":
      return {
        kind: "spawned-by",
        spawnedByParticipantId: ParticipantId.make(row.provenance_participant_id!),
        source: row.provenance_source!,
      } as const;
    case "forked-from":
      return {
        kind: "forked-from",
        sourceParticipantId: ParticipantId.make(row.provenance_participant_id!),
        source: "upstream_lineage",
      } as const;
  }
};

const placementFromRow = (row: PlacementRow) =>
  decodePlacement({
    squadronId: row.squadron_id,
    participantId: row.participant_id,
    provenance: provenanceFromRow(row),
    placementParentId: row.placement_parent_id,
    createdEventSeq: row.created_event_seq,
    updatedEventSeq: row.updated_event_seq,
  });

/**
 * Decodes current creation events and reserved historical reparent vocabulary.
 * No reparent producer ships; recovery belongs to the future human-reparent
 * surface under R21 and the A6 ticket recovery note, from frozen chain
 * 8fb7139d161aed2f7f9bb8d9d31e4130a3dd604a.
 */
const eventFromRow = (row: EventRow) =>
  decodeEvent(
    row.kind === "participant.placement_created"
      ? {
          seq: row.seq,
          commandId: row.command_id,
          squadronId: row.squadron_id,
          participantId: row.participant_id,
          kind: row.kind,
          actor: row.actor,
          provenance: provenanceFromRow({
            provenance_kind: row.provenance_kind!,
            provenance_participant_id: row.provenance_participant_id,
            provenance_source: row.provenance_source,
          }),
          previousParentId: null,
          placementParentId: row.placement_parent_id,
          createdAt: row.created_at,
        }
      : {
          // Reparent identity fields are non-null by the event-table CHECK.
          seq: row.seq,
          commandId: row.command_id,
          squadronId: row.squadron_id,
          participantId: row.participant_id,
          kind: row.kind,
          actor: "human",
          actorSessionId: row.actor_session_id!,
          actorSubject: row.actor_subject!,
          authMethod: row.auth_method!,
          provenance: null,
          previousParentId: row.previous_parent_id,
          placementParentId: row.placement_parent_id,
          createdAt: row.created_at,
        },
  );

const preserveDomainError =
  (operation: string) =>
  (cause: unknown): PlacementError =>
    isPlacementError(cause) ? cause : new PlacementStorageError({ operation, cause });

const creationFingerprint = (input: RecordParticipantPlacementInput): string => {
  const provenanceFields =
    input.provenance.kind === "unknown"
      ? {
          provenanceKind: "unknown" as const,
          provenanceParticipantId: null,
          provenanceSource: "native_or_unobserved" as const,
        }
      : input.provenance.kind === "spawned-by"
        ? {
            provenanceKind: "spawned-by" as const,
            provenanceParticipantId: input.provenance.spawnedByParticipantId,
            provenanceSource: input.provenance.source,
          }
        : {
            provenanceKind: "forked-from" as const,
            provenanceParticipantId: input.provenance.sourceParticipantId,
            provenanceSource: input.provenance.source,
          };
  return JSON.stringify({
    type: "record_creation",
    squadronId: input.squadronId,
    participantId: input.participantId,
    actor: input.actor,
    ...provenanceFields,
    createdAt: input.createdAt,
  });
};

export const layer: Layer.Layer<ParticipantPlacementService, never, SqlClient.SqlClient> =
  Layer.effect(
    ParticipantPlacementService,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const mutationPermit = yield* Semaphore.make(1);

      const ensureSquadron = Effect.fn("j5.a2a.placement.ensureSquadron")(function* (
        squadronId: SquadronId,
      ) {
        const rows = yield* sql<{ readonly id: string }>`
          SELECT id FROM j5_a2a_squadron WHERE id = ${squadronId} LIMIT 1
        `;
        if (rows[0] === undefined) return yield* new PlacementSquadronNotFoundError({ squadronId });
      });

      const ensureParticipant = Effect.fn("j5.a2a.placement.ensureParticipant")(function* (
        squadronId: SquadronId,
        participantId: ParticipantId,
      ) {
        const rows = yield* sql<{ readonly participant_id: string }>`
          SELECT participant_id
          FROM j5_a2a_squadron_membership
          WHERE squadron_id = ${squadronId} AND participant_id = ${participantId}
          LIMIT 1
        `;
        if (rows[0] === undefined) {
          return yield* new PlacementParticipantNotFoundError({ squadronId, participantId });
        }
      });

      const ensureProvenanceParticipant = Effect.fn("j5.a2a.placement.ensureProvenanceParticipant")(
        function* (squadronId: SquadronId, participantId: ParticipantId) {
          const rows = yield* sql<{ readonly participant_id: string }>`
          SELECT json_extract(payload, '$.participant.id') AS participant_id
          FROM j5_a2a_comm_event
          WHERE squadron_id = ${squadronId}
            AND kind = 'participant.joined'
            AND json_extract(payload, '$.participant.id') = ${participantId}
          LIMIT 1
        `;
          if (rows[0] === undefined) {
            return yield* new PlacementParticipantNotFoundError({ squadronId, participantId });
          }
        },
      );

      const ensureParent = Effect.fn("j5.a2a.placement.ensureParent")(function* (
        squadronId: SquadronId,
        parentParticipantId: ParticipantId | null,
      ) {
        if (parentParticipantId === null) return;
        if (isHumanParticipantId(parentParticipantId)) {
          return yield* new PlacementParentIneligibleError({
            squadronId,
            parentParticipantId,
          });
        }
        const rows = yield* sql<{ readonly participant_id: string }>`
          SELECT participant_id
          FROM j5_a2a_squadron_membership
          WHERE squadron_id = ${squadronId} AND participant_id = ${parentParticipantId}
          LIMIT 1
        `;
        if (rows[0] === undefined) {
          return yield* new PlacementParentNotFoundError({ squadronId, parentParticipantId });
        }
      });

      const isCurrentParticipant = Effect.fn("j5.a2a.placement.isCurrentParticipant")(function* (
        squadronId: SquadronId,
        participantId: ParticipantId,
      ) {
        const rows = yield* sql<{ readonly participant_id: string }>`
            SELECT participant_id
            FROM j5_a2a_squadron_membership
            WHERE squadron_id = ${squadronId} AND participant_id = ${participantId}
            LIMIT 1
          `;
        return rows[0] !== undefined;
      });

      const selectPlacement = Effect.fn("j5.a2a.placement.selectPlacement")(function* (
        squadronId: SquadronId,
        participantId: ParticipantId,
      ) {
        const rows = yield* sql<PlacementRow>`
          SELECT
            squadron_id,
            participant_id,
            provenance_kind,
            provenance_participant_id,
            provenance_source,
            placement_parent_id,
            created_event_seq,
            updated_event_seq
          FROM j5_a2a_participant_placement
          WHERE squadron_id = ${squadronId} AND participant_id = ${participantId}
          LIMIT 1
        `;
        return rows[0] === undefined ? null : yield* placementFromRow(rows[0]);
      });

      const selectEventByCommand = Effect.fn("j5.a2a.placement.selectEventByCommand")(function* (
        commandId: string,
      ) {
        const rows = yield* sql<EventRow>`
            SELECT
              seq,
              command_id,
              request_fingerprint,
              squadron_id,
              participant_id,
              kind,
              actor,
              actor_session_id,
              actor_subject,
              auth_method,
              provenance_kind,
              provenance_participant_id,
              provenance_source,
              previous_parent_id,
              placement_parent_id,
              created_at
            FROM j5_a2a_placement_event
            WHERE command_id = ${commandId}
            LIMIT 1
          `;
        return rows[0] ?? null;
      });

      const replay = Effect.fn("j5.a2a.placement.replay")(function* (
        commandId: string,
        fingerprint: string,
      ) {
        const row = yield* selectEventByCommand(commandId);
        if (row === null) return null;
        if (row.request_fingerprint !== fingerprint) {
          return yield* new PlacementCommandConflictError({
            commandId,
            existingParticipantId: ParticipantId.make(row.participant_id),
          });
        }
        const placement = yield* selectPlacement(
          SquadronId.make(row.squadron_id),
          ParticipantId.make(row.participant_id),
        );
        if (placement === null) {
          return yield* new PlacementStorageError({ operation: "read replayed placement" });
        }
        return {
          event: yield* eventFromRow(row),
          placement,
          committed: false as const,
        };
      });

      const allocateSeq = Effect.fn("j5.a2a.placement.allocateSeq")(function* (
        squadronId: SquadronId,
      ) {
        const rows = yield* sql<{ readonly next_seq: number }>`
          SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
          FROM j5_a2a_placement_event
          WHERE squadron_id = ${squadronId}
        `;
        const seq = rows[0]?.next_seq;
        if (seq === undefined) {
          return yield* new PlacementStorageError({ operation: "allocate placement sequence" });
        }
        return seq;
      });

      const resolveProvenanceDefaultParent = Effect.fn(
        "j5.a2a.placement.resolveProvenanceDefaultParent",
      )(function* (input: RecordParticipantPlacementInput) {
        switch (input.provenance.kind) {
          case "spawned-by":
            if (input.provenance.source === "j5_spawn") {
              return input.provenance.spawnedByParticipantId;
            }
            return (yield* isCurrentParticipant(
              input.squadronId,
              input.provenance.spawnedByParticipantId,
            ))
              ? input.provenance.spawnedByParticipantId
              : null;
          case "forked-from": {
            const source = yield* selectPlacement(
              input.squadronId,
              input.provenance.sourceParticipantId,
            );
            return source?.placementParentId ?? null;
          }
          case "unknown":
            return null;
        }
      });

      const assertAcyclic = Effect.fn("j5.a2a.placement.assertAcyclic")(function* (input: {
        readonly squadronId: SquadronId;
        readonly participantId: ParticipantId;
        readonly requestedParentId: ParticipantId | null;
      }) {
        if (input.requestedParentId === null) return;
        const countRows = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM j5_a2a_participant_placement WHERE squadron_id = ${input.squadronId}
        `;
        const placementBound = (countRows[0]?.count ?? 0) + 1;
        const visited = new Set<ParticipantId>();
        const path: Array<ParticipantId> = [];
        let current: ParticipantId | null = input.requestedParentId;
        while (current !== null) {
          path.push(current);
          if (current === input.participantId) {
            return yield* new PlacementCycleError({
              participantId: input.participantId,
              requestedParentId: input.requestedParentId,
              path,
            });
          }
          if (visited.has(current) || path.length > placementBound) {
            return yield* new PlacementGraphCorruptError({ squadronId: input.squadronId, path });
          }
          visited.add(current);
          const placement: ParticipantPlacement | null = yield* selectPlacement(
            input.squadronId,
            current,
          );
          current = placement?.placementParentId ?? null;
        }
      });

      const recordCreationEffect = Effect.fn("j5.a2a.placement.recordCreation")(function* (
        input: RecordParticipantPlacementInput,
      ) {
        if (isHumanParticipantId(input.participantId)) {
          return yield* new PlacementHumanTargetError({
            operation: "record-creation",
            squadronId: input.squadronId,
            participantId: input.participantId,
          });
        }
        const fingerprint = creationFingerprint(input);
        const replayed = yield* replay(input.commandId, fingerprint);
        if (replayed !== null) return replayed;
        yield* ensureSquadron(input.squadronId);
        yield* ensureParticipant(input.squadronId, input.participantId);
        if ((yield* selectPlacement(input.squadronId, input.participantId)) !== null) {
          return yield* new PlacementAlreadyExistsError({
            squadronId: input.squadronId,
            participantId: input.participantId,
          });
        }
        const provenanceParticipantId =
          input.provenance.kind === "spawned-by"
            ? input.provenance.spawnedByParticipantId
            : input.provenance.kind === "forked-from"
              ? input.provenance.sourceParticipantId
              : null;
        if (provenanceParticipantId !== null) {
          // Immutable provenance may retain a departed source, but it must name
          // an identity that actually joined this squadron at least once.
          yield* ensureProvenanceParticipant(input.squadronId, provenanceParticipantId);
        }
        if (provenanceParticipantId === input.participantId) {
          return yield* new PlacementCycleError({
            participantId: input.participantId,
            requestedParentId: input.participantId,
            path: [input.participantId],
          });
        }
        const placementParentId = yield* resolveProvenanceDefaultParent(input);
        yield* ensureParent(input.squadronId, placementParentId);
        yield* assertAcyclic({
          squadronId: input.squadronId,
          participantId: input.participantId,
          requestedParentId: placementParentId,
        });
        const seq = yield* allocateSeq(input.squadronId);
        const provenanceKind = input.provenance.kind;
        const provenanceSource =
          input.provenance.kind === "unknown" ? null : input.provenance.source;
        yield* sql`
            INSERT INTO j5_a2a_placement_event (
              seq,
              command_id,
              request_fingerprint,
              squadron_id,
              participant_id,
              kind,
              actor,
              actor_session_id,
              actor_subject,
              auth_method,
              provenance_kind,
              provenance_participant_id,
              provenance_source,
              previous_parent_id,
              placement_parent_id,
              created_at
            ) VALUES (
              ${seq},
              ${input.commandId},
              ${fingerprint},
              ${input.squadronId},
              ${input.participantId},
              'participant.placement_created',
              ${input.actor},
              NULL,
              NULL,
              NULL,
              ${provenanceKind},
              ${provenanceParticipantId},
              ${provenanceSource},
              NULL,
              ${placementParentId},
              ${input.createdAt}
            )
          `;
        yield* sql`
            INSERT INTO j5_a2a_participant_placement (
              squadron_id,
              participant_id,
              provenance_kind,
              provenance_participant_id,
              provenance_source,
              placement_parent_id,
              created_event_seq,
              updated_event_seq
            ) VALUES (
              ${input.squadronId},
              ${input.participantId},
              ${provenanceKind},
              ${provenanceParticipantId},
              ${provenanceSource},
              ${placementParentId},
              ${seq},
              ${seq}
            )
          `;
        const event = yield* eventFromRow({
          seq,
          command_id: input.commandId,
          request_fingerprint: fingerprint,
          squadron_id: input.squadronId,
          participant_id: input.participantId,
          kind: "participant.placement_created",
          actor: input.actor,
          actor_session_id: null,
          actor_subject: null,
          auth_method: null,
          provenance_kind: provenanceKind,
          provenance_participant_id: provenanceParticipantId,
          provenance_source: provenanceSource,
          previous_parent_id: null,
          placement_parent_id: placementParentId,
          created_at: input.createdAt,
        });
        const placement = yield* selectPlacement(input.squadronId, input.participantId);
        if (placement === null) {
          return yield* new PlacementStorageError({ operation: "read created placement" });
        }
        return { event, placement, committed: true as const };
      });

      const listParticipantsEffect = Effect.fn("j5.a2a.placement.listParticipants")(function* (
        squadronId: SquadronId,
      ) {
        yield* ensureSquadron(squadronId);
        const rows = yield* sql<ParticipantRow>`
            SELECT
              m.payload,
              m.squadron_id,
              m.participant_id,
              p.provenance_kind,
              p.provenance_participant_id,
              p.provenance_source,
              p.placement_parent_id
            FROM j5_a2a_squadron_membership m
            LEFT JOIN j5_a2a_participant_placement p
              ON p.squadron_id = m.squadron_id AND p.participant_id = m.participant_id
            WHERE m.squadron_id = ${squadronId}
            ORDER BY m.participant_id
          `;
        return yield* Effect.forEach(
          rows,
          (row) =>
            Effect.gen(function* () {
              const participant = yield* decodeParticipant(row.payload);
              const id = participantIdOf(participant);
              return {
                squadronId,
                participant,
                participantId: id,
                threadId: participant.kind === "agent" ? participant.threadId : null,
                provenance:
                  participant.kind === "human"
                    ? ({ kind: "not-applicable" } as const)
                    : row.provenance_kind === null
                      ? ({ kind: "unrecorded" } as const)
                      : provenanceFromRow({
                          provenance_kind: row.provenance_kind,
                          provenance_participant_id: row.provenance_participant_id,
                          provenance_source: row.provenance_source,
                        }),
                placementParentId:
                  participant.kind === "human"
                    ? null
                    : row.placement_parent_id === null
                      ? null
                      : ParticipantId.make(row.placement_parent_id),
              } satisfies ParticipantPlacementView;
            }),
          { concurrency: 1 },
        );
      });

      return ParticipantPlacementService.of({
        recordCreation: (input) =>
          mutationPermit
            .withPermit(sql.withTransaction(recordCreationEffect(input)))
            .pipe(Effect.mapError(preserveDomainError("record participant placement"))),
        readPlacement: ({ squadronId, participantId }) =>
          Effect.gen(function* () {
            yield* ensureSquadron(squadronId);
            return yield* selectPlacement(squadronId, participantId);
          }).pipe(Effect.mapError(preserveDomainError("read participant placement"))),
        listParticipants: (squadronId) =>
          listParticipantsEffect(squadronId).pipe(
            Effect.mapError(preserveDomainError("list participant placements")),
          ),
        listSubtree: ({ squadronId, participantId }) =>
          Effect.gen(function* () {
            yield* ensureParticipant(squadronId, participantId);
            const participants = yield* listParticipantsEffect(squadronId);
            const byId = new Map(
              participants.map((participant) => [participant.participantId, participant]),
            );
            const children = new Map<ParticipantId, Array<ParticipantId>>();
            for (const participant of participants) {
              if (participant.placementParentId === null) continue;
              const siblings = children.get(participant.placementParentId) ?? [];
              siblings.push(participant.participantId);
              children.set(participant.placementParentId, siblings);
            }
            for (const siblings of children.values()) siblings.sort();
            const visiting = new Set<ParticipantId>();
            const visited = new Set<ParticipantId>();
            const path: Array<ParticipantId> = [];
            const ordered: Array<ParticipantPlacementView> = [];
            const visit = (id: ParticipantId): Effect.Effect<void, PlacementGraphCorruptError> =>
              Effect.gen(function* () {
                if (visiting.has(id)) {
                  return yield* new PlacementGraphCorruptError({ squadronId, path: [...path, id] });
                }
                if (visited.has(id)) return;
                visiting.add(id);
                path.push(id);
                for (const childId of children.get(id) ?? []) yield* visit(childId);
                path.pop();
                visiting.delete(id);
                visited.add(id);
                const participant = byId.get(id);
                if (participant !== undefined) ordered.push(participant);
              });
            yield* visit(participantId);
            return ordered;
          }).pipe(Effect.mapError(preserveDomainError("list placement subtree"))),
      });
    }),
  );
