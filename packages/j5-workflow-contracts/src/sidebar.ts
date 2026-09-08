import * as Schema from "effect/Schema";
import { RunStatus } from "./index.ts";

export const WorkflowEntry = Schema.Struct({
  id: Schema.String,
  squadronId: Schema.String,
  title: Schema.String,
  phase: Schema.String,
  status: RunStatus,
  revision: Schema.Number,
  gateRevision: Schema.NullOr(Schema.Number),
  // Optional for entries produced by a server that has not restarted onto the
  // timestamp projection yet. The client renders legacy activity as unavailable.
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
});
export type WorkflowEntry = typeof WorkflowEntry.Type;
export const WorkflowEntries = Schema.Struct({
  runs: Schema.Array(WorkflowEntry),
  hasMore: Schema.Boolean,
  // Optional during rolling client/server upgrades. Clients must not present a
  // missing approval count as a confirmed zero.
  total: Schema.optional(Schema.Number),
  waitingApprovalCount: Schema.optional(Schema.Number),
});

export const WorkflowThreadParent = Schema.Struct({
  runId: Schema.String,
  squadronId: Schema.String,
  title: Schema.String,
});
export type WorkflowThreadParent = typeof WorkflowThreadParent.Type;

// The workflow launch adapter reserves this namespace; titles are never ownership evidence.
export const isWorkflowThread = (id: string): boolean => /^thread:wf:[a-f0-9]{64}$/.test(id);
