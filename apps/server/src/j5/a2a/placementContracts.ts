import { AuthSessionId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { SquadronId, Participant, ParticipantId } from "./contracts.ts";

const Identifier = Schema.String.check(Schema.isNonEmpty());
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export const PlacementCommandId = Identifier.pipe(Schema.brand("J5A2APlacementCommandId"));
export type PlacementCommandId = typeof PlacementCommandId.Type;

export const PlacementActor = Schema.Literals(["human", "agent", "platform"]);
export type PlacementActor = typeof PlacementActor.Type;

export const SpawnedByParticipantProvenance = Schema.Struct({
  kind: Schema.Literal("spawned-by"),
  spawnedByParticipantId: ParticipantId,
  source: Schema.Literals(["upstream_lineage", "j5_spawn"]),
});
export type SpawnedByParticipantProvenance = typeof SpawnedByParticipantProvenance.Type;

export const ForkedFromParticipantProvenance = Schema.Struct({
  kind: Schema.Literal("forked-from"),
  sourceParticipantId: ParticipantId,
  source: Schema.Literal("upstream_lineage"),
});
export type ForkedFromParticipantProvenance = typeof ForkedFromParticipantProvenance.Type;

export const UnknownParticipantProvenance = Schema.Struct({
  kind: Schema.Literal("unknown"),
  source: Schema.Literal("native_or_unobserved"),
});
export type UnknownParticipantProvenance = typeof UnknownParticipantProvenance.Type;

export const ParticipantProvenance = Schema.Union([
  SpawnedByParticipantProvenance,
  ForkedFromParticipantProvenance,
  UnknownParticipantProvenance,
]);
export type ParticipantProvenance = typeof ParticipantProvenance.Type;

/** `unknown` is recorded provenance; `unrecorded` means no placement event exists yet. */
export const ParticipantProvenanceView = Schema.Union([
  SpawnedByParticipantProvenance,
  ForkedFromParticipantProvenance,
  UnknownParticipantProvenance,
  Schema.Struct({ kind: Schema.Literal("unrecorded") }),
  Schema.Struct({ kind: Schema.Literal("not-applicable") }),
]);
export type ParticipantProvenanceView = typeof ParticipantProvenanceView.Type;

export const ParticipantPlacement = Schema.Struct({
  squadronId: SquadronId,
  participantId: ParticipantId,
  provenance: ParticipantProvenance,
  placementParentId: Schema.NullOr(ParticipantId),
  createdEventSeq: PositiveInt,
  updatedEventSeq: PositiveInt,
});
export type ParticipantPlacement = typeof ParticipantPlacement.Type;

export const PlacementCreatedEvent = Schema.Struct({
  seq: PositiveInt,
  commandId: PlacementCommandId,
  squadronId: SquadronId,
  participantId: ParticipantId,
  kind: Schema.Literal("participant.placement_created"),
  actor: PlacementActor,
  provenance: ParticipantProvenance,
  previousParentId: Schema.Null,
  placementParentId: Schema.NullOr(ParticipantId),
  createdAt: Schema.String,
});
export type PlacementCreatedEvent = typeof PlacementCreatedEvent.Type;

export const PlacementReparentedEvent = Schema.Struct({
  seq: PositiveInt,
  commandId: PlacementCommandId,
  squadronId: SquadronId,
  participantId: ParticipantId,
  kind: Schema.Literal("participant.reparented"),
  actor: Schema.Literal("human"),
  actorSessionId: AuthSessionId,
  actorSubject: Schema.String.check(Schema.isNonEmpty()),
  authMethod: Schema.Literal("browser-session-cookie"),
  provenance: Schema.Null,
  previousParentId: Schema.NullOr(ParticipantId),
  placementParentId: Schema.NullOr(ParticipantId),
  createdAt: Schema.String,
});
export type PlacementReparentedEvent = typeof PlacementReparentedEvent.Type;

export const PlacementEvent = Schema.Union([PlacementCreatedEvent, PlacementReparentedEvent]);
export type PlacementEvent = typeof PlacementEvent.Type;

export const RecordParticipantPlacementInput = Schema.Struct({
  commandId: PlacementCommandId,
  squadronId: SquadronId,
  participantId: ParticipantId,
  actor: PlacementActor,
  provenance: ParticipantProvenance,
  createdAt: Schema.String,
});
export type RecordParticipantPlacementInput = typeof RecordParticipantPlacementInput.Type;

export const ParticipantPlacementView = Schema.Struct({
  squadronId: SquadronId,
  participant: Participant,
  participantId: ParticipantId,
  threadId: Schema.NullOr(ThreadId),
  provenance: ParticipantProvenanceView,
  placementParentId: Schema.NullOr(ParticipantId),
});
export type ParticipantPlacementView = typeof ParticipantPlacementView.Type;

export interface PlacementMutationResult {
  readonly event: PlacementEvent;
  readonly placement: ParticipantPlacement;
  readonly committed: boolean;
}
