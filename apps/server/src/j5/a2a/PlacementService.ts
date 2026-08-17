import { EnvironmentAuthenticatedPrincipal, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import {
  EpicId,
  Participant,
  ParticipantId,
  participantId as participantIdOf,
} from "./contracts.ts";
import {
  ParticipantPlacement,
  type ParticipantPlacementView,
  PlacementEvent,
  type PlacementMutationResult,
  type RecordParticipantPlacementInput,
  type ReparentParticipantInput,
} from "./placementContracts.ts";

export class PlacementStorageError extends Schema.TaggedErrorClass<PlacementStorageError>()(
  "PlacementStorageError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class PlacementEpicNotFoundError extends Schema.TaggedErrorClass<PlacementEpicNotFoundError>()(
  "PlacementEpicNotFoundError",
  { epicId: EpicId },
) {
  override get message(): string {
    return `Placement epic state is missing for ${this.epicId}. Create the epic before placing participants.`;
  }
}

export class PlacementParticipantNotFoundError extends Schema.TaggedErrorClass<PlacementParticipantNotFoundError>()(
  "PlacementParticipantNotFoundError",
  { epicId: EpicId, participantId: ParticipantId },
) {
  override get message(): string {
    return `Placement participant state is missing for ${this.participantId} in epic ${this.epicId}. Join the participant before changing placement.`;
  }
}

export class PlacementParentNotFoundError extends Schema.TaggedErrorClass<PlacementParentNotFoundError>()(
  "PlacementParentNotFoundError",
  { epicId: EpicId, parentParticipantId: ParticipantId },
) {
  override get message(): string {
    return `Placement parent state is missing for ${this.parentParticipantId} in epic ${this.epicId}. Choose an active participant or root.`;
  }
}

export class PlacementAlreadyExistsError extends Schema.TaggedErrorClass<PlacementAlreadyExistsError>()(
  "PlacementAlreadyExistsError",
  { epicId: EpicId, participantId: ParticipantId },
) {
  override get message(): string {
    return `Placement state already exists for ${this.participantId} in epic ${this.epicId}; provenance is immutable. Use the human reparent command to change only display placement.`;
  }
}

export class PlacementReferenceUnavailableError extends Schema.TaggedErrorClass<PlacementReferenceUnavailableError>()(
  "PlacementReferenceUnavailableError",
  {
    participantId: ParticipantId,
    provenanceKind: Schema.Literals(["forked-from", "unknown"]),
    requestedPlacement: Schema.Literals(["spawner", "sibling"]),
  },
) {
  override get message(): string {
    return `Placement reference state is unavailable for ${this.participantId}: provenance is ${this.provenanceKind}, so ${this.requestedPlacement} placement cannot be resolved. Choose root or an explicit other parent.`;
  }
}

export class PlacementHumanRequiredError extends Schema.TaggedErrorClass<PlacementHumanRequiredError>()(
  "PlacementHumanRequiredError",
  {
    actor: Schema.Literal("agent"),
    participantId: ParticipantId,
    providerSessionId: Schema.String,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Placement actor state is agent for ${this.participantId}: MCP session ${this.providerSessionId} on thread ${this.threadId} cannot reparent. Retry from a human-authenticated command.`;
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
    return `Placement cycle state: reparenting ${this.participantId} under ${this.requestedParentId} would make it its own ancestor through ${this.path.join(" -> ")}. Choose root or a participant outside that subtree.`;
  }
}

export class PlacementGraphCorruptError extends Schema.TaggedErrorClass<PlacementGraphCorruptError>()(
  "PlacementGraphCorruptError",
  { epicId: EpicId, path: Schema.Array(ParticipantId) },
) {
  override get message(): string {
    return `Placement graph state is already cyclic or exceeds its membership bound in epic ${this.epicId}: ${this.path.join(" -> ")}. Repair the placement projection before retrying.`;
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
  | PlacementEpicNotFoundError
  | PlacementParticipantNotFoundError
  | PlacementParentNotFoundError
  | PlacementAlreadyExistsError
  | PlacementReferenceUnavailableError
  | PlacementHumanRequiredError
  | PlacementCycleError
  | PlacementGraphCorruptError
  | PlacementCommandConflictError;

const PlacementErrorSchema = Schema.Union([
  PlacementStorageError,
  PlacementEpicNotFoundError,
  PlacementParticipantNotFoundError,
  PlacementParentNotFoundError,
  PlacementAlreadyExistsError,
  PlacementReferenceUnavailableError,
  PlacementHumanRequiredError,
  PlacementCycleError,
  PlacementGraphCorruptError,
  PlacementCommandConflictError,
]);
const isPlacementError = Schema.is(PlacementErrorSchema);

export interface ParticipantPlacementServiceShape {
  readonly recordCreation: (
    input: RecordParticipantPlacementInput,
  ) => Effect.Effect<PlacementMutationResult, PlacementError>;
  readonly reparent: (
    input: ReparentParticipantInput,
  ) => Effect.Effect<PlacementMutationResult, PlacementError, EnvironmentAuthenticatedPrincipal>;
  readonly reparentFromMcp: (
    scope: McpInvocationScope,
    input: ReparentParticipantInput,
  ) => Effect.Effect<never, PlacementHumanRequiredError>;
  readonly readPlacement: (input: {
    readonly epicId: EpicId;
    readonly participantId: ParticipantId;
  }) => Effect.Effect<ParticipantPlacement | null, PlacementError>;
  readonly listParticipants: (
    epicId: EpicId,
  ) => Effect.Effect<ReadonlyArray<ParticipantPlacementView>, PlacementError>;
  /** Placement descendants in leaves-first order, including the requested root. */
  readonly listSubtree: (input: {
    readonly epicId: EpicId;
    readonly participantId: ParticipantId;
  }) => Effect.Effect<ReadonlyArray<ParticipantPlacementView>, PlacementError>;
  readonly listEvents: (
    epicId: EpicId,
  ) => Effect.Effect<ReadonlyArray<PlacementEvent>, PlacementError>;
  readonly rebuildProjection: (
    epicId: EpicId,
  ) => Effect.Effect<ReadonlyArray<ParticipantPlacement>, PlacementError>;
}

export class ParticipantPlacementService extends Context.Service<
  ParticipantPlacementService,
  ParticipantPlacementServiceShape
>()("t3/j5/a2a/PlacementService/ParticipantPlacementService") {}

interface EventRow {
  readonly seq: number;
  readonly command_id: string;
  readonly request_fingerprint: string;
  readonly epic_id: string;
  readonly participant_id: string;
  readonly kind: "participant.placement_created" | "participant.reparented";
  readonly actor: "human" | "agent" | "platform";
  readonly provenance_kind: "spawned-by" | "forked-from" | "unknown" | null;
  readonly provenance_participant_id: string | null;
  readonly provenance_source: "upstream_lineage" | "j5_wrapper" | null;
  readonly previous_parent_id: string | null;
  readonly placement_parent_id: string | null;
  readonly created_at: string;
}

interface PlacementRow {
  readonly epic_id: string;
  readonly participant_id: string;
  readonly provenance_kind: "spawned-by" | "forked-from" | "unknown";
  readonly provenance_participant_id: string | null;
  readonly provenance_source: "upstream_lineage" | "j5_wrapper" | null;
  readonly placement_parent_id: string | null;
  readonly created_event_seq: number;
  readonly updated_event_seq: number;
}

interface ParticipantRow extends PlacementRow {
  readonly payload: string;
}

const decodeEvent = Schema.decodeUnknownEffect(PlacementEvent);
const decodePlacement = Schema.decodeUnknownEffect(ParticipantPlacement);
const decodeParticipant = Schema.decodeUnknownEffect(Schema.fromJsonString(Participant));

const provenanceFromRow = (row: {
  readonly provenance_kind: "spawned-by" | "forked-from" | "unknown";
  readonly provenance_participant_id: string | null;
  readonly provenance_source: "upstream_lineage" | "j5_wrapper" | null;
}) => {
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
    epicId: row.epic_id,
    participantId: row.participant_id,
    provenance: provenanceFromRow(row),
    placementParentId: row.placement_parent_id,
    createdEventSeq: row.created_event_seq,
    updatedEventSeq: row.updated_event_seq,
  });

const eventFromRow = (row: EventRow) =>
  decodeEvent(
    row.kind === "participant.placement_created"
      ? {
          seq: row.seq,
          commandId: row.command_id,
          epicId: row.epic_id,
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
          seq: row.seq,
          commandId: row.command_id,
          epicId: row.epic_id,
          participantId: row.participant_id,
          kind: row.kind,
          actor: "human",
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

const creationFingerprint = (input: RecordParticipantPlacementInput): string =>
  JSON.stringify({
    type: "record_creation",
    epicId: input.epicId,
    participantId: input.participantId,
    actor: input.actor,
    provenance: input.provenance,
    placement: input.placement,
    createdAt: input.createdAt,
  });

const reparentFingerprint = (input: ReparentParticipantInput): string =>
  JSON.stringify({
    type: "reparent",
    epicId: input.epicId,
    participantId: input.participantId,
    placementParentId: input.placementParentId,
    createdAt: input.createdAt,
  });

export const layer: Layer.Layer<ParticipantPlacementService, never, SqlClient.SqlClient> =
  Layer.effect(
    ParticipantPlacementService,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const mutationPermit = yield* Semaphore.make(1);

      const ensureEpic = Effect.fn("j5.a2a.placement.ensureEpic")(function* (epicId: EpicId) {
        const rows = yield* sql<{ readonly id: string }>`
          SELECT id FROM j5_a2a_epic WHERE id = ${epicId} LIMIT 1
        `;
        if (rows[0] === undefined) return yield* new PlacementEpicNotFoundError({ epicId });
      });

      const ensureParticipant = Effect.fn("j5.a2a.placement.ensureParticipant")(function* (
        epicId: EpicId,
        participantId: ParticipantId,
      ) {
        const rows = yield* sql<{ readonly participant_id: string }>`
          SELECT participant_id
          FROM j5_a2a_epic_membership
          WHERE epic_id = ${epicId} AND participant_id = ${participantId}
          LIMIT 1
        `;
        if (rows[0] === undefined) {
          return yield* new PlacementParticipantNotFoundError({ epicId, participantId });
        }
      });

      const ensureParent = Effect.fn("j5.a2a.placement.ensureParent")(function* (
        epicId: EpicId,
        parentParticipantId: ParticipantId | null,
      ) {
        if (parentParticipantId === null) return;
        const rows = yield* sql<{ readonly participant_id: string }>`
          SELECT participant_id
          FROM j5_a2a_epic_membership
          WHERE epic_id = ${epicId} AND participant_id = ${parentParticipantId}
          LIMIT 1
        `;
        if (rows[0] === undefined) {
          return yield* new PlacementParentNotFoundError({ epicId, parentParticipantId });
        }
      });

      const selectPlacement = Effect.fn("j5.a2a.placement.selectPlacement")(function* (
        epicId: EpicId,
        participantId: ParticipantId,
      ) {
        const rows = yield* sql<PlacementRow>`
          SELECT
            epic_id,
            participant_id,
            provenance_kind,
            provenance_participant_id,
            provenance_source,
            placement_parent_id,
            created_event_seq,
            updated_event_seq
          FROM j5_a2a_participant_placement
          WHERE epic_id = ${epicId} AND participant_id = ${participantId}
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
              epic_id,
              participant_id,
              kind,
              actor,
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
          EpicId.make(row.epic_id),
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

      const allocateSeq = Effect.fn("j5.a2a.placement.allocateSeq")(function* (epicId: EpicId) {
        const rows = yield* sql<{ readonly next_seq: number }>`
          SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
          FROM j5_a2a_placement_event
          WHERE epic_id = ${epicId}
        `;
        const seq = rows[0]?.next_seq;
        if (seq === undefined) {
          return yield* new PlacementStorageError({ operation: "allocate placement sequence" });
        }
        return seq;
      });

      const resolveCreationParent = Effect.fn("j5.a2a.placement.resolveCreationParent")(function* (
        input: RecordParticipantPlacementInput,
      ) {
        const siblingOf = (sourceParticipantId: ParticipantId) =>
          selectPlacement(input.epicId, sourceParticipantId).pipe(
            Effect.map((source) => source?.placementParentId ?? null),
          );
        switch (input.placement.type) {
          case "default":
            switch (input.provenance.kind) {
              case "spawned-by":
                return input.provenance.spawnedByParticipantId;
              case "forked-from":
                return yield* siblingOf(input.provenance.sourceParticipantId);
              case "unknown":
                return null;
            }
          case "root":
            return null;
          case "other_parent":
            return input.placement.parentParticipantId;
          case "spawner":
            if (input.provenance.kind !== "spawned-by") {
              return yield* new PlacementReferenceUnavailableError({
                participantId: input.participantId,
                provenanceKind: input.provenance.kind,
                requestedPlacement: "spawner",
              });
            }
            return input.provenance.spawnedByParticipantId;
          case "sibling": {
            if (input.provenance.kind === "unknown") {
              return yield* new PlacementReferenceUnavailableError({
                participantId: input.participantId,
                provenanceKind: input.provenance.kind,
                requestedPlacement: "sibling",
              });
            }
            return yield* siblingOf(
              input.provenance.kind === "spawned-by"
                ? input.provenance.spawnedByParticipantId
                : input.provenance.sourceParticipantId,
            );
          }
        }
      });

      const assertAcyclic = Effect.fn("j5.a2a.placement.assertAcyclic")(function* (input: {
        readonly epicId: EpicId;
        readonly participantId: ParticipantId;
        readonly requestedParentId: ParticipantId | null;
      }) {
        if (input.requestedParentId === null) return;
        const countRows = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM j5_a2a_epic_membership WHERE epic_id = ${input.epicId}
        `;
        const membershipBound = (countRows[0]?.count ?? 0) + 1;
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
          if (visited.has(current) || path.length > membershipBound) {
            return yield* new PlacementGraphCorruptError({ epicId: input.epicId, path });
          }
          visited.add(current);
          const placement: ParticipantPlacement | null = yield* selectPlacement(
            input.epicId,
            current,
          );
          current = placement?.placementParentId ?? null;
        }
      });

      const recordCreationEffect = Effect.fn("j5.a2a.placement.recordCreation")(function* (
        input: RecordParticipantPlacementInput,
      ) {
        const fingerprint = creationFingerprint(input);
        const replayed = yield* replay(input.commandId, fingerprint);
        if (replayed !== null) return replayed;
        yield* ensureEpic(input.epicId);
        yield* ensureParticipant(input.epicId, input.participantId);
        if ((yield* selectPlacement(input.epicId, input.participantId)) !== null) {
          return yield* new PlacementAlreadyExistsError({
            epicId: input.epicId,
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
          yield* ensureParticipant(input.epicId, provenanceParticipantId);
        }
        if (provenanceParticipantId === input.participantId) {
          return yield* new PlacementCycleError({
            participantId: input.participantId,
            requestedParentId: input.participantId,
            path: [input.participantId],
          });
        }
        const placementParentId = yield* resolveCreationParent(input);
        yield* ensureParent(input.epicId, placementParentId);
        yield* assertAcyclic({
          epicId: input.epicId,
          participantId: input.participantId,
          requestedParentId: placementParentId,
        });
        const seq = yield* allocateSeq(input.epicId);
        const provenanceKind = input.provenance.kind;
        const provenanceSource =
          input.provenance.kind === "unknown" ? null : input.provenance.source;
        yield* sql`
            INSERT INTO j5_a2a_placement_event (
              seq,
              command_id,
              request_fingerprint,
              epic_id,
              participant_id,
              kind,
              actor,
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
              ${input.epicId},
              ${input.participantId},
              'participant.placement_created',
              ${input.actor},
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
              epic_id,
              participant_id,
              provenance_kind,
              provenance_participant_id,
              provenance_source,
              placement_parent_id,
              created_event_seq,
              updated_event_seq
            ) VALUES (
              ${input.epicId},
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
          epic_id: input.epicId,
          participant_id: input.participantId,
          kind: "participant.placement_created",
          actor: input.actor,
          provenance_kind: provenanceKind,
          provenance_participant_id: provenanceParticipantId,
          provenance_source: provenanceSource,
          previous_parent_id: null,
          placement_parent_id: placementParentId,
          created_at: input.createdAt,
        });
        const placement = yield* selectPlacement(input.epicId, input.participantId);
        if (placement === null) {
          return yield* new PlacementStorageError({ operation: "read created placement" });
        }
        return { event, placement, committed: true as const };
      });

      const reparentEffect = Effect.fn("j5.a2a.placement.reparent")(function* (
        input: ReparentParticipantInput,
      ) {
        const fingerprint = reparentFingerprint(input);
        const replayed = yield* replay(input.commandId, fingerprint);
        if (replayed !== null) return replayed;
        yield* ensureEpic(input.epicId);
        yield* ensureParticipant(input.epicId, input.participantId);
        yield* ensureParent(input.epicId, input.placementParentId);
        const current = yield* selectPlacement(input.epicId, input.participantId);
        if (current === null) {
          return yield* new PlacementParticipantNotFoundError({
            epicId: input.epicId,
            participantId: input.participantId,
          });
        }
        yield* assertAcyclic({
          epicId: input.epicId,
          participantId: input.participantId,
          requestedParentId: input.placementParentId,
        });
        const seq = yield* allocateSeq(input.epicId);
        yield* sql`
          INSERT INTO j5_a2a_placement_event (
            seq,
            command_id,
            request_fingerprint,
            epic_id,
            participant_id,
            kind,
            actor,
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
            ${input.epicId},
            ${input.participantId},
            'participant.reparented',
            'human',
            NULL,
            NULL,
            NULL,
            ${current.placementParentId},
            ${input.placementParentId},
            ${input.createdAt}
          )
        `;
        yield* sql`
          UPDATE j5_a2a_participant_placement
          SET placement_parent_id = ${input.placementParentId}, updated_event_seq = ${seq}
          WHERE epic_id = ${input.epicId} AND participant_id = ${input.participantId}
        `;
        const event = yield* eventFromRow({
          seq,
          command_id: input.commandId,
          request_fingerprint: fingerprint,
          epic_id: input.epicId,
          participant_id: input.participantId,
          kind: "participant.reparented",
          actor: "human",
          provenance_kind: null,
          provenance_participant_id: null,
          provenance_source: null,
          previous_parent_id: current.placementParentId,
          placement_parent_id: input.placementParentId,
          created_at: input.createdAt,
        });
        const placement = yield* selectPlacement(input.epicId, input.participantId);
        if (placement === null) {
          return yield* new PlacementStorageError({ operation: "read reparented placement" });
        }
        return { event, placement, committed: true as const };
      });

      const listParticipantsEffect = Effect.fn("j5.a2a.placement.listParticipants")(function* (
        epicId: EpicId,
      ) {
        yield* ensureEpic(epicId);
        const rows = yield* sql<ParticipantRow>`
            SELECT
              m.payload,
              m.epic_id,
              m.participant_id,
              COALESCE(p.provenance_kind, 'unknown') AS provenance_kind,
              p.provenance_participant_id,
              p.provenance_source,
              p.placement_parent_id,
              COALESCE(p.created_event_seq, 1) AS created_event_seq,
              COALESCE(p.updated_event_seq, 1) AS updated_event_seq
            FROM j5_a2a_epic_membership m
            LEFT JOIN j5_a2a_participant_placement p
              ON p.epic_id = m.epic_id AND p.participant_id = m.participant_id
            WHERE m.epic_id = ${epicId}
            ORDER BY m.participant_id
          `;
        return yield* Effect.forEach(
          rows,
          (row) =>
            Effect.gen(function* () {
              const participant = yield* decodeParticipant(row.payload);
              const id = participantIdOf(participant);
              return {
                epicId,
                participant,
                participantId: id,
                threadId: participant.kind === "agent" ? participant.threadId : null,
                provenance:
                  participant.kind === "human"
                    ? ({ kind: "not-applicable" } as const)
                    : provenanceFromRow(row),
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

      const listEventsEffect = Effect.fn("j5.a2a.placement.listEvents")(function* (epicId: EpicId) {
        yield* ensureEpic(epicId);
        const rows = yield* sql<EventRow>`
          SELECT
            seq,
            command_id,
            request_fingerprint,
            epic_id,
            participant_id,
            kind,
            actor,
            provenance_kind,
            provenance_participant_id,
            provenance_source,
            previous_parent_id,
            placement_parent_id,
            created_at
          FROM j5_a2a_placement_event
          WHERE epic_id = ${epicId}
          ORDER BY seq
        `;
        return yield* Effect.forEach(rows, eventFromRow, { concurrency: 1 });
      });

      const rebuildProjectionEffect = Effect.fn("j5.a2a.placement.rebuildProjection")(function* (
        epicId: EpicId,
      ) {
        yield* ensureEpic(epicId);
        const rows = yield* sql<EventRow>`
            SELECT
              seq,
              command_id,
              request_fingerprint,
              epic_id,
              participant_id,
              kind,
              actor,
              provenance_kind,
              provenance_participant_id,
              provenance_source,
              previous_parent_id,
              placement_parent_id,
              created_at
            FROM j5_a2a_placement_event
            WHERE epic_id = ${epicId}
            ORDER BY seq
          `;
        yield* sql`DELETE FROM j5_a2a_participant_placement WHERE epic_id = ${epicId}`;
        for (const row of rows) {
          if (row.kind === "participant.placement_created") {
            yield* sql`
                INSERT INTO j5_a2a_participant_placement (
                  epic_id,
                  participant_id,
                  provenance_kind,
                  provenance_participant_id,
                  provenance_source,
                  placement_parent_id,
                  created_event_seq,
                  updated_event_seq
                ) VALUES (
                  ${row.epic_id},
                  ${row.participant_id},
                  ${row.provenance_kind},
                  ${row.provenance_participant_id},
                  ${row.provenance_source},
                  ${row.placement_parent_id},
                  ${row.seq},
                  ${row.seq}
                )
              `;
          } else {
            yield* sql`
                UPDATE j5_a2a_participant_placement
                SET placement_parent_id = ${row.placement_parent_id}, updated_event_seq = ${row.seq}
                WHERE epic_id = ${row.epic_id} AND participant_id = ${row.participant_id}
              `;
          }
        }
        const placements = yield* sql<PlacementRow>`
            SELECT
              epic_id,
              participant_id,
              provenance_kind,
              provenance_participant_id,
              provenance_source,
              placement_parent_id,
              created_event_seq,
              updated_event_seq
            FROM j5_a2a_participant_placement
            WHERE epic_id = ${epicId}
            ORDER BY participant_id
          `;
        return yield* Effect.forEach(placements, placementFromRow, { concurrency: 1 });
      });

      return ParticipantPlacementService.of({
        recordCreation: (input) =>
          mutationPermit
            .withPermit(sql.withTransaction(recordCreationEffect(input)))
            .pipe(Effect.mapError(preserveDomainError("record participant placement"))),
        reparent: (input) =>
          EnvironmentAuthenticatedPrincipal.pipe(
            Effect.andThen(mutationPermit.withPermit(sql.withTransaction(reparentEffect(input)))),
            Effect.mapError(preserveDomainError("reparent participant")),
          ),
        reparentFromMcp: (scope, input) =>
          Effect.fail(
            new PlacementHumanRequiredError({
              actor: "agent",
              participantId: input.participantId,
              providerSessionId: scope.providerSessionId,
              threadId: scope.threadId,
            }),
          ),
        readPlacement: ({ epicId, participantId }) =>
          Effect.gen(function* () {
            yield* ensureEpic(epicId);
            return yield* selectPlacement(epicId, participantId);
          }).pipe(Effect.mapError(preserveDomainError("read participant placement"))),
        listParticipants: (epicId) =>
          listParticipantsEffect(epicId).pipe(
            Effect.mapError(preserveDomainError("list participant placements")),
          ),
        listSubtree: ({ epicId, participantId }) =>
          Effect.gen(function* () {
            yield* ensureParticipant(epicId, participantId);
            const participants = yield* listParticipantsEffect(epicId);
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
                  return yield* new PlacementGraphCorruptError({ epicId, path: [...path, id] });
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
        listEvents: (epicId) =>
          listEventsEffect(epicId).pipe(
            Effect.mapError(preserveDomainError("list placement events")),
          ),
        rebuildProjection: (epicId) =>
          mutationPermit
            .withPermit(sql.withTransaction(rebuildProjectionEffect(epicId)))
            .pipe(Effect.mapError(preserveDomainError("rebuild placement projection"))),
      });
    }),
  );
