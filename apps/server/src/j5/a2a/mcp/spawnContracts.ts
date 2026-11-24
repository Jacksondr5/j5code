import { RunId, RuntimeMode, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { LedgerProjectId, ParticipantId } from "../contracts.ts";

// Apart from tools.ts, which imports SpawnAgentService for its dependency list: SpawnAgentService
// needs these as values, and importing them from there would close the cycle.

/**
 * What a linked J5 machine's server sends with a spawn its agent asked for there, beside the
 * `T3-Sender-Thread` that names the agent: the facts this server can't read from the header.
 */
export const J5LinkedSpawnFacts = Schema.Struct({
  spawner_project_id: LedgerProjectId,
  pick_source: Schema.Literals(["person", "agent"]),
  caller_access: Schema.Struct({
    runtime_mode: RuntimeMode,
    sandbox: Schema.optional(Schema.Literals(["readOnly", "workspaceWrite"])),
  }),
  author_models: Schema.Array(Schema.String),
  authors_partly_unknown: Schema.Boolean,
});
export type J5LinkedSpawnFacts = typeof J5LinkedSpawnFacts.Type;

export const J5SpawnAgentResult = Schema.Struct({
  participant_id: ParticipantId,
  thread_id: ThreadId,
  link: Schema.String,
  /** The run the brief started, to wait on; null if it could not be read. */
  run_id: Schema.NullOr(RunId),
  project_id: LedgerProjectId,
  project_title: Schema.String,
  /** The linked machine the agent runs on, by its link's name; absent for this one. */
  server: Schema.optional(Schema.String),
  placement: Schema.Struct({
    /**
     * The spawner, when the agent joined the spawner's own project; null in another project, and
     * for every agent an outside agent starts.
     */
    placement_parent_id: Schema.NullOr(ParticipantId),
    provenance: Schema.Struct({
      kind: Schema.Literal("spawned-by"),
      spawned_by_participant_id: ParticipantId,
      source: Schema.Literal("j5_spawn"),
    }),
  }),
});
