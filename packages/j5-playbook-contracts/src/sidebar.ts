import * as Schema from "effect/Schema";
import { RunStatus } from "./index.ts";

export const PlaybookEntry = Schema.Struct({
  id: Schema.String,
  squadronId: Schema.String,
  title: Schema.String,
  phase: Schema.String,
  status: RunStatus,
  revision: Schema.Number,
  gateRevision: Schema.NullOr(Schema.Number),
  updatedAt: Schema.String,
});
export type PlaybookEntry = typeof PlaybookEntry.Type;
export const PlaybookEntries = Schema.Struct({
  runs: Schema.Array(PlaybookEntry),
  hasMore: Schema.Boolean,
  total: Schema.Number,
  waitingApprovalCount: Schema.Number,
});

export const PlaybookApprovalCount = Schema.Struct({ count: Schema.Number });

export const PlaybookThreadParent = Schema.Struct({
  runId: Schema.String,
  squadronId: Schema.String,
  title: Schema.String,
});
export type PlaybookThreadParent = typeof PlaybookThreadParent.Type;

// The playbook launch adapter reserves this namespace; titles are never ownership evidence.
export const isPlaybookThread = (id: string): boolean => /^thread:pb:[a-f0-9]{64}$/.test(id);
