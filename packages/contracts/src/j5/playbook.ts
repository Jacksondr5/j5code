import * as Schema from "effect/Schema";
import { ProjectId, ThreadId } from "../baseSchemas.ts";

export const PLAYBOOK_MAX_BYTES = 262144;
export const PLAYBOOK_MAX_STEPS = 100;
export const PLAYBOOK_NAME_PATTERN = /^[^/\\\p{Cc}]+$/u;

const Text = Schema.String.check(Schema.isPattern(/\S/));
export const PlaybookStep = Schema.Struct({ id: Text, title: Text, prompt: Text });
export const PlaybookDefinition = Schema.Struct({
  title: Text,
  description: Text,
  steps: Schema.Array(PlaybookStep).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(PLAYBOOK_MAX_STEPS),
  ),
});
export type PlaybookDefinition = typeof PlaybookDefinition.Type;

export class PlaybookError extends Schema.TaggedError<PlaybookError>()("PlaybookError", {
  code: Schema.String,
  message: Schema.String,
  availableStepIds: Schema.Array(Schema.String),
}) {}

export const PlaybookRun = Schema.Struct({
  runId: Text,
  ownerThreadId: ThreadId,
  definitionPath: Text,
  currentStepId: Text,
  status: Schema.Literals(["active", "completed", "cancelled"]),
  createdAt: Text,
  updatedAt: Text,
});
export type PlaybookRun = typeof PlaybookRun.Type;

/** The board receives titles, never the other steps' prompt bodies. */
export const PlaybookProgress = Schema.Struct({
  ...PlaybookRun.fields,
  title: Schema.String,
  description: Schema.String,
  steps: Schema.Array(Schema.Struct({ id: Text, title: Text })),
  position: Schema.NullOr(Schema.Int),
  total: Schema.Int,
  issue: Schema.NullOr(PlaybookError),
});
export type PlaybookProgress = typeof PlaybookProgress.Type;
export const PlaybookStepResponse = Schema.Struct({
  ...PlaybookProgress.fields,
  currentStep: Schema.NullOr(PlaybookStep),
  replayed: Schema.Boolean,
});
export type PlaybookStepResponse = typeof PlaybookStepResponse.Type;
export const PlaybookDiscovery = Schema.Struct({
  playbooks: Schema.Array(
    Schema.Struct({
      name: Text,
      title: Schema.String,
      description: Schema.String,
      stepCount: Schema.Int,
      steps: Schema.Array(Schema.Struct({ id: Text, title: Text })),
      issue: Schema.NullOr(PlaybookError),
    }),
  ),
});
export const ThreadPlaybooksRequest = Schema.Struct({ threadId: ThreadId });
export const ThreadPlaybooksResponse = Schema.Struct({ runs: Schema.Array(PlaybookProgress) });
export const PLAYBOOK_PROGRESS_PATH = "/api/j5/playbooks/thread";
export const PLAYBOOK_RUNS_PATH = "/api/j5/playbooks/runs";
export const PLAYBOOK_RUNS_PAGE_SIZE = 100;
export const PlaybookRunsRequest = Schema.Struct({
  status: Schema.optionalKey(Schema.Literals(["active", "all"])),
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type PlaybookRunsRequest = typeof PlaybookRunsRequest.Type;
export const PlaybookRunsResponse = Schema.Struct({
  runs: Schema.Array(PlaybookProgress),
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export const PlaybookLibraryRequest = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optionalKey(ThreadId),
});
export type PlaybookLibraryRequest = typeof PlaybookLibraryRequest.Type;
export const PlaybookLibraryResponse = Schema.Struct({
  workspaceRoot: Schema.String,
  ...PlaybookDiscovery.fields,
});
export const PLAYBOOK_LIBRARY_PATH = "/api/j5/playbooks/library";
export const PlaybookDeleteRequest = Schema.Struct({
  ...PlaybookLibraryRequest.fields,
  name: Text,
});
export type PlaybookDeleteRequest = typeof PlaybookDeleteRequest.Type;
export const PlaybookDeleteResponse = Schema.Struct({ deleted: Schema.Boolean });
export const PLAYBOOK_DELETE_PATH = "/api/j5/playbooks/delete";
export const PlaybookRenameRequest = Schema.Struct({
  ...PlaybookLibraryRequest.fields,
  name: Text,
  title: Text,
});
export type PlaybookRenameRequest = typeof PlaybookRenameRequest.Type;
export const PlaybookRenameResponse = Schema.Struct({ renamed: Schema.Boolean });
export const PLAYBOOK_RENAME_PATH = "/api/j5/playbooks/rename";
