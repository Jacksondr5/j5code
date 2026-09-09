import * as Schema from "effect/Schema";
import { Decision, RunStatus, WorkflowFailureCategory } from "./index.ts";

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const BoardActionKind = Schema.Literals(["agent", "code"]);
export type BoardActionKind = typeof BoardActionKind.Type;
export const BoardActionStatus = Schema.Literals(["pending", "claimed", "blocked"]);
export type BoardActionStatus = typeof BoardActionStatus.Type;
export const BoardActionSummary = Schema.Struct({
  actionId: Schema.String,
  phase: Schema.String,
  task: Schema.String,
  attempt: PositiveInt,
  actionKind: BoardActionKind,
  actionStatus: BoardActionStatus,
  deadline: Schema.Number,
  threadId: Schema.NullOr(Schema.String),
  sessionRunId: Schema.NullOr(Schema.String),
  sessionStatus: Schema.NullOr(Schema.String),
  requestedAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
});
export type BoardActionSummary = typeof BoardActionSummary.Type;

export const BoardCard = Schema.Struct({
  id: Schema.String,
  squadronId: Schema.String,
  title: Schema.String,
  phase: Schema.String,
  status: RunStatus,
  revision: NonNegativeInt,
  gateRevision: Schema.NullOr(NonNegativeInt),
  updatedAt: Schema.String,
  readVersion: PositiveInt,
  definitionId: Schema.String,
  definitionVersion: PositiveInt,
  definitionHash: Schema.String,
  visit: Schema.NullOr(PositiveInt),
  visits: Schema.Record(Schema.String, PositiveInt),
  failureCategory: Schema.NullOr(WorkflowFailureCategory),
  actions: Schema.Array(BoardActionSummary),
});
export type BoardCard = typeof BoardCard.Type;

export const BoardPage = Schema.Struct({
  cards: Schema.Array(BoardCard),
  hasMore: Schema.Boolean,
  total: NonNegativeInt,
  waitingApprovalCount: NonNegativeInt,
});
export type BoardPage = typeof BoardPage.Type;

export const TimelineKind = Schema.Literals([
  "phase_entered",
  "gate_opened",
  "gate_revised",
  "action_queued",
  "action_correction",
  "action_completed",
  "action_failed",
  "decision",
  "restart_requested",
  "restart_ready",
  "restart_cleanup_failed",
  "cancel_requested",
  "cancelled",
  "invalidated",
  "recovered",
  "blocked",
  "completed",
  "event",
]);
export type TimelineKind = typeof TimelineKind.Type;

export const TimelineEntry = Schema.Struct({
  id: Schema.String,
  kind: TimelineKind,
  phase: Schema.NullOr(Schema.String),
  visit: Schema.NullOr(PositiveInt),
  fromPhase: Schema.optional(Schema.String),
  fromVisit: Schema.optional(PositiveInt),
  actionId: Schema.optional(Schema.String),
  task: Schema.optional(Schema.String),
  attempt: Schema.optional(PositiveInt),
  actionKind: Schema.optional(BoardActionKind),
  threadId: Schema.optional(Schema.String),
  verdict: Schema.optional(Schema.String),
  replacesActionId: Schema.optional(Schema.String),
  gateRevision: Schema.optional(NonNegativeInt),
  artifactHash: Schema.optional(Schema.String),
  decision: Schema.optional(Decision.fields.decision),
  actor: Schema.optional(Schema.String),
  failureCategory: Schema.optional(WorkflowFailureCategory),
  cause: Schema.optional(Schema.String),
  eventType: Schema.optional(Schema.String),
  partial: Schema.Boolean,
});
export type TimelineEntry = typeof TimelineEntry.Type;

export const TimelineRevision = Schema.Struct({
  revision: NonNegativeInt,
  recordedAt: Schema.NullOr(Schema.String),
  partial: Schema.Boolean,
  entries: Schema.Array(TimelineEntry),
});
export type TimelineRevision = typeof TimelineRevision.Type;

export const TimelinePage = Schema.Struct({
  runId: Schema.String,
  headRevision: NonNegativeInt,
  readVersion: PositiveInt,
  revisions: Schema.Array(TimelineRevision),
  nextBefore: Schema.NullOr(NonNegativeInt),
});
export type TimelinePage = typeof TimelinePage.Type;
