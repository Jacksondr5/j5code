import { PlaybookDiscovery, PlaybookError, PlaybookStepResponse } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Tool } from "effect/unstable/ai";
import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { PlaybookStore, playbookError, type PlaybookMutation } from "./PlaybookStore.ts";

const isPlaybookError = Schema.is(PlaybookError);
const Text = Schema.String.check(Schema.isNonEmpty());
const Mutation = Schema.Struct({ runId: Text, client_request_id: Text });
const Movement = Schema.Struct({ ...Mutation.fields, expectedStepId: Text });
const Reselection = Schema.Struct({ ...Movement.fields, stepId: Text });
const Start = Schema.Struct({ name: Text, client_request_id: Text });
const Current = Schema.Struct({ runId: Schema.optional(Text) });
const dependencies = [McpInvocationContext, PlaybookStore];
const workspaceDependencies = [...dependencies, ThreadManagementService, ProjectService];
const common = {
  success: PlaybookStepResponse,
  failure: PlaybookError,
  failureMode: "return" as const,
  dependencies,
};
const mutationDescription =
  " Reuse client_request_id only to retry this exact operation; use a fresh ID for each new action. A replay returns current live progress without moving again.";

export const playbookTools = [
  Tool.make("playbook_list", {
    description:
      "Discover live YAML playbooks in your thread workspace's .j5/playbooks directory. Invalid files include actionable errors.",
    success: PlaybookDiscovery,
    failure: PlaybookError,
    failureMode: "return",
    dependencies: workspaceDependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("playbook_start", {
    ...common,
    dependencies: workspaceDependencies,
    parameters: Start,
    description:
      "Start a named playbook in your own thread and retrieve its first live prompt. Only one run may be active. You perform the work and control advancement; the playbook never spawns or stops agents." +
      mutationDescription,
  }),
  Tool.make("playbook_current", {
    ...common,
    parameters: Current,
    description:
      "Retrieve your run's live prompt, purpose and progress without moving. Omit runId to recover your active (or latest) run after compaction or restart. If a current step was deleted, use playbook_reselect.",
  }).annotate(Tool.Readonly, true),
  Tool.make("playbook_next", {
    ...common,
    parameters: Movement,
    description:
      "Advance one step in the latest YAML order and retrieve its prompt. expectedStepId must equal your current step. At the last step, use playbook_complete." +
      mutationDescription,
  }),
  Tool.make("playbook_back", {
    ...common,
    parameters: Movement,
    description:
      "Move back one step in the latest YAML order and retrieve its live prompt. This changes progress only; it does not undo work or file edits. expectedStepId guards against stale calls." +
      mutationDescription,
  }),
  Tool.make("playbook_reselect", {
    ...common,
    parameters: Reselection,
    description:
      "Explicitly select an available stepId, including recovery when the stored current step was removed. expectedStepId must equal the stored currentStepId, even if that ID is absent from YAML." +
      mutationDescription,
  }),
  Tool.make("playbook_complete", {
    ...common,
    parameters: Movement,
    description:
      "Mark the playbook completed. expectedStepId guards against stale completion. Your agent and thread remain usable; you may start another playbook." +
      mutationDescription,
  }),
  Tool.make("playbook_cancel", {
    ...common,
    parameters: Mutation,
    description:
      "Cancel your playbook even when its YAML is missing or invalid. This does not interrupt or archive your agent." +
      mutationDescription,
  }),
] as const;

const ownerScope = Effect.gen(function* () {
  const scope = yield* McpInvocationContext;
  if (!scope.capabilities.has("orchestration"))
    return yield* playbookError(
      "capability_denied",
      "This credential does not grant orchestration access.",
    );
  return scope;
});
const workspace = Effect.gen(function* () {
  const scope = yield* ownerScope;
  const threads = yield* ThreadManagementService;
  const projects = yield* ProjectService;
  const { thread } = yield* threads.getThreadProjection(scope.threadId);
  if (thread.deletedAt !== null)
    return yield* playbookError("thread_not_found", "The owner thread was deleted.");
  const project = yield* projects.getById(thread.projectId);
  if (Option.isNone(project))
    return yield* playbookError("project_not_found", "The thread's project was not found.");
  return { owner: scope.threadId, root: thread.worktreePath ?? project.value.workspaceRoot };
}).pipe(
  Effect.mapError((error) =>
    isPlaybookError(error) ? error : playbookError("workspace_unavailable", error.message),
  ),
);

const mutate = Effect.fn("PlaybookMcp.mutate")(function* (input: PlaybookMutation) {
  const scope = yield* ownerScope;
  return yield* (yield* PlaybookStore).mutate(scope.threadId, input);
});
export const playbookHandlers = {
  playbook_list: () =>
    Effect.gen(function* () {
      const { root } = yield* workspace;
      return yield* (yield* PlaybookStore).discover(root);
    }),
  playbook_start: (input: typeof Start.Type) =>
    Effect.gen(function* () {
      const { owner, root } = yield* workspace;
      return yield* (yield* PlaybookStore).start(owner, root, input.name, input.client_request_id);
    }),
  playbook_current: (input: typeof Current.Type) =>
    Effect.gen(function* () {
      const scope = yield* ownerScope;
      return yield* (yield* PlaybookStore).current(scope.threadId, input.runId);
    }),
  playbook_next: (input: typeof Movement.Type) => mutate({ ...input, operation: "next" }),
  playbook_back: (input: typeof Movement.Type) => mutate({ ...input, operation: "back" }),
  playbook_reselect: (input: typeof Reselection.Type) =>
    mutate({ ...input, operation: "reselect" }),
  playbook_complete: (input: typeof Movement.Type) => mutate({ ...input, operation: "complete" }),
  playbook_cancel: (input: typeof Mutation.Type) => mutate({ ...input, operation: "cancel" }),
};
