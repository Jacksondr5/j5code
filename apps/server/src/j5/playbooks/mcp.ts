import {
  PlaybookDiscovery,
  PlaybookError,
  PlaybookReadResponse,
  PlaybookStepResponse,
} from "@t3tools/contracts/j5";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";
import { McpInvocationContext, requireThreadScope } from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { PlaybookCrewRelay } from "./PlaybookCrewRelay.ts";
import { PlaybookStore, playbookError, type PlaybookMutation } from "./PlaybookStore.ts";
import { playbookWorkspaceRoot } from "./workspace.ts";

const Text = Schema.String.check(Schema.isNonEmpty());
const Mutation = Schema.Struct({ runId: Text, client_request_id: Text });
const Movement = Schema.Struct({ ...Mutation.fields, expectedStepId: Text });
const Reselection = Schema.Struct({ ...Movement.fields, stepId: Text });
const Start = Schema.Struct({
  name: Text,
  client_request_id: Text,
  crew_instance_id: Schema.optional(Text),
});
const Current = Schema.Struct({ runId: Schema.optional(Text) });
const Read = Schema.Struct({ name: Text });
// McpToolAccess reads the calling thread before each tool, hence ThreadManagementService.
const dependencies = [
  McpInvocationContext,
  ThreadManagementService,
  PlaybookStore,
  PlaybookCrewRelay,
];
const workspaceDependencies = [...dependencies, ProjectService];
/** A playbook's own refusal, or McpToolAccess's refusal of a caller that is not a live thread. */
const Failure = Schema.Union([PlaybookError, OrchestratorMcpFailure]);
const common = {
  success: PlaybookStepResponse,
  failure: Failure,
  failureMode: "return" as const,
  dependencies,
};
const mutationDescription =
  " Reuse client_request_id only to retry this exact operation; use a fresh ID for each new action. Active-run retries return current live progress without moving again. After completion or cancellation, only start and finish retries are retained.";

export const playbookTools = [
  Tool.make("j5_playbook_list", {
    description:
      "Discover live YAML playbooks in your thread workspace's .j5/playbooks directory, with each step's persona. Invalid files include actionable errors; non-blocking warnings name steps whose persona is missing or turned off.",
    success: PlaybookDiscovery,
    failure: Failure,
    failureMode: "return",
    dependencies: workspaceDependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("j5_playbook_read", {
    description:
      "Read a playbook's live definition, with every step's prompt and persona, without starting a run. Pass the same name as j5_playbook_start. warnings name steps whose persona is missing or turned off; they never block starting.",
    parameters: Read,
    success: PlaybookReadResponse,
    failure: Failure,
    failureMode: "return",
    dependencies: workspaceDependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("j5_playbook_start", {
    ...common,
    dependencies: workspaceDependencies,
    parameters: Start,
    description:
      "Start a named playbook in your own thread and retrieve its first live prompt. Only one run may be active. You perform the work and control advancement; the playbook never spawns or stops agents. As a Captain, pass crew_instance_id to run the playbook your Crew follows: each step then goes to the seat that owns it, and delivery says who holds it." +
      mutationDescription,
  }),
  Tool.make("j5_playbook_current", {
    ...common,
    parameters: Current,
    description:
      "Retrieve your run's live prompt, purpose and progress without moving. Omit runId to recover your active (or latest) run after compaction or restart. If a current step was deleted, use j5_playbook_reselect.",
  }).annotate(Tool.Readonly, true),
  Tool.make("j5_playbook_next", {
    ...common,
    parameters: Movement,
    description:
      "Advance one step in the latest YAML order and retrieve its prompt. expectedStepId must equal your current step. At the last step, use j5_playbook_complete." +
      mutationDescription,
  }),
  Tool.make("j5_playbook_back", {
    ...common,
    parameters: Movement,
    description:
      "Move back one step in the latest YAML order and retrieve its live prompt. This changes progress only; it does not undo work or file edits. expectedStepId guards against stale calls." +
      mutationDescription,
  }),
  Tool.make("j5_playbook_reselect", {
    ...common,
    parameters: Reselection,
    description:
      "Explicitly select an available stepId, including recovery when the stored current step was removed. expectedStepId must equal the stored currentStepId, even if that ID is absent from YAML." +
      mutationDescription,
  }),
  Tool.make("j5_playbook_complete", {
    ...common,
    parameters: Movement,
    description:
      "Mark the playbook completed. expectedStepId guards against stale completion. Your agent and thread remain usable; you may start another playbook." +
      mutationDescription,
  }),
  Tool.make("j5_playbook_cancel", {
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
  // Every playbook tool is declared to need a calling thread, which owns the run.
  return (yield* requireThreadScope(scope, "A playbook tool")).thread.threadId;
});
const workspace = Effect.gen(function* () {
  const owner = yield* ownerScope;
  return { owner, root: yield* playbookWorkspaceRoot(owner) };
});

const mutate = Effect.fn("PlaybookMcp.mutate")(function* (input: PlaybookMutation) {
  return yield* (yield* PlaybookCrewRelay).mutate(yield* ownerScope, input);
});

export const playbookHandlers = {
  j5_playbook_list: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const { root } = yield* workspace;
      return yield* (yield* PlaybookStore).discover(root);
    }),
  ),
  j5_playbook_read: McpToolAccess.readsAsCaller((input: typeof Read.Type) =>
    Effect.gen(function* () {
      const { root } = yield* workspace;
      return yield* (yield* PlaybookStore).read(root, input.name);
    }),
  ),
  j5_playbook_start: McpToolAccess.actsAsCaller((input: typeof Start.Type) =>
    Effect.gen(function* () {
      const { owner, root } = yield* workspace;
      if (input.crew_instance_id === undefined)
        return yield* (yield* PlaybookStore).start(
          owner,
          root,
          input.name,
          input.client_request_id,
        );
      return yield* (yield* PlaybookCrewRelay).start({
        owner,
        root,
        name: input.name,
        key: input.client_request_id,
        crewInstanceId: input.crew_instance_id,
      });
    }),
  ),
  j5_playbook_current: McpToolAccess.readsAsCaller((input: typeof Current.Type) =>
    Effect.gen(function* () {
      return yield* (yield* PlaybookCrewRelay).current(yield* ownerScope, input.runId);
    }),
  ),
  j5_playbook_next: McpToolAccess.actsAsCaller((input: typeof Movement.Type) =>
    mutate({ ...input, operation: "next" }),
  ),
  j5_playbook_back: McpToolAccess.actsAsCaller((input: typeof Movement.Type) =>
    mutate({ ...input, operation: "back" }),
  ),
  j5_playbook_reselect: McpToolAccess.actsAsCaller((input: typeof Reselection.Type) =>
    mutate({ ...input, operation: "reselect" }),
  ),
  j5_playbook_complete: McpToolAccess.actsAsCaller((input: typeof Movement.Type) =>
    mutate({ ...input, operation: "complete" }),
  ),
  j5_playbook_cancel: McpToolAccess.actsAsCaller((input: typeof Mutation.Type) =>
    mutate({ ...input, operation: "cancel" }),
  ),
};
