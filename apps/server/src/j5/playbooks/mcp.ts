import {
  PlaybookDiscovery,
  PlaybookError,
  PlaybookReadResponse,
  PlaybookStepResponse,
  PlaybookSaveRequest,
  PlaybookReviseRequest,
  PlaybookSaveResponse,
} from "@t3tools/contracts/j5";
import { isAgentPersonaAuthorityPolicy, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";
import { McpInvocationContext, requireThreadScope } from "../../mcp/McpInvocationContext.ts";
import { actsAsThreadCaller, readsAsThreadCaller, spawnAndBrief } from "../a2a/mcp/outsideAgent.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { PlaybookCrewRelay } from "./PlaybookCrewRelay.ts";
import { PlaybookStore, playbookError, type PlaybookMutation } from "./PlaybookStore.ts";
import { mapAgentPersonaPolicy } from "../agents/agentPersonas.ts";
import { readCaller } from "../../mcp/threadAccess.ts";
import { playbookWorkspaceRoot } from "./workspace.ts";

const Text = Schema.String.check(Schema.isNonEmpty());
const Mutation = Schema.Struct({ runId: Text, client_request_id: Text });
const Movement = Schema.Struct({
  ...Mutation.fields,
  expectedStepId: Text,
  assignee: Schema.optional(Text),
});
const Next = Schema.Struct({
  ...Movement.fields,
  summary: Schema.optionalKey(Text.check(Schema.isMaxLength(8000))),
});
const Finish = Schema.Struct({
  ...Mutation.fields,
  expectedStepId: Text,
  summary: Schema.optionalKey(Text.check(Schema.isMaxLength(8000))),
});
const Start = Schema.Struct({
  name: Text,
  client_request_id: Text,
  assignee: Schema.optional(Text),
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
  Tool.make("j5_playbook_save", {
    description:
      "Save YAML to the environment library after an Owner approves the full draft in a new chat turn. It is the default location unless the user asks for a workspace-only definition. If owner_required, leave the draft in chat for an Owner to save. Pass expectedDigest from j5_playbook_read for library edits. For a team-folder override, warn that the copy hides later team updates and removal restores the team version, then pass overrideFolder: true after approval. Edit workspace-only playbooks in .j5/playbooks. Identical saves are safe retries.",
    parameters: PlaybookSaveRequest,
    success: PlaybookSaveResponse,
    failure: Failure,
    failureMode: "return",
    dependencies,
  }),
  Tool.make("j5_playbook_list", {
    description:
      "Discover live YAML playbooks from this environment's libraries and your thread workspace's .j5/playbooks directory, with each step's persona. Invalid files include actionable errors; non-blocking warnings name steps whose persona is missing or turned off.",
    success: PlaybookDiscovery,
    failure: Failure,
    failureMode: "return",
    dependencies: workspaceDependencies,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.OpenWorld, false),
  Tool.make("j5_playbook_read", {
    description:
      "Read a playbook's live definition, with every step's prompt and persona, its source, and the digest an edit through j5_playbook_save needs, without starting a run. Pass the same name as j5_playbook_start. warnings name steps whose persona is missing or turned off; they never block starting.",
    parameters: Read,
    success: PlaybookReadResponse,
    failure: Failure,
    failureMode: "return",
    dependencies: workspaceDependencies,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.OpenWorld, false),
  Tool.make("j5_playbook_start", {
    ...common,
    dependencies: workspaceDependencies,
    parameters: Start,
    description:
      "Start a named playbook in your own thread. Pass an assignee participant ID to hand the first step to an agent you spawned or a member of a Crew you captain; otherwise you hold it. Delivery reports whether the notice reached the holder. Only you advance the run." +
      mutationDescription,
  }),
  Tool.make("j5_playbook_current", {
    ...common,
    parameters: Current,
    description:
      "Retrieve your run's saved prompt, holder, delivery status and progress without moving. Omit runId to recover your active (or latest) run after compaction or restart.",
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.OpenWorld, false),
  Tool.make("j5_playbook_next", {
    ...common,
    parameters: Next,
    description:
      "Advance one step in the saved step order and retrieve its prompt. Pass an optional assignee participant ID for that step; otherwise you hold it. expectedStepId must equal your current step. At the last step, use j5_playbook_complete. A required checkpoint needs a summary of the finished work; approval_pending means stop and wait for a person to answer." +
      mutationDescription,
  }),
  Tool.make("j5_playbook_back", {
    ...common,
    parameters: Movement,
    description:
      "Move back one step in the saved step order and retrieve its saved prompt. Pass an optional assignee participant ID for that step; otherwise you hold it. This changes progress only; it does not undo work or file edits. expectedStepId guards against stale calls." +
      mutationDescription,
  }),
  Tool.make("j5_playbook_assign", {
    ...common,
    parameters: Movement,
    description:
      "Hand the current step to an assignee participant ID, or omit assignee to take it back without moving. This can replace a pending hand-off to an unavailable holder. expectedStepId guards against a stale assignment." +
      mutationDescription,
  }),
  Tool.make("j5_playbook_revise", {
    ...common,
    parameters: PlaybookReviseRequest,
    description:
      "Replace only your active run's steps after the user explicitly asked for the change (basis asked) or approved your proposal (basis approved). Preserve its title and purpose. expectedStepId guards against stale calls. If the current step ID remains, keep it; otherwise supply stepId naming its replacement. This never changes the reusable playbook. For a changed current step, assignee optionally names an eligible local agent; omit it to assign the owner. Editing the same step keeps its holder unless its required persona changes; then pass a matching assignee to reassign it in the revision." +
      mutationDescription,
  }),
  Tool.make("j5_playbook_complete", {
    ...common,
    parameters: Finish,
    description:
      "Mark the playbook completed. A required checkpoint needs a summary and refuses with approval_pending until a person approves. expectedStepId guards against stale completion. Your agent and thread remain usable; you may start another playbook." +
      mutationDescription,
  }),
  Tool.make("j5_playbook_cancel", {
    ...common,
    parameters: Mutation,
    description:
      "Cancel your playbook first, then stop its current holder if that is another agent. Your own turn is never interrupted. The result records whether Stop was requested, unnecessary, or failed; retries do not stop again. Work and history remain." +
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

/** A run belongs to a calling thread, so an outside agent is told to start one that runs it. */
const runsPlaybook = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  actsAsThreadCaller("A playbook tool", spawnAndBrief("run the playbook"), handle);

/** Playbooks are read from the calling thread's workspace, and a run is read by its owner. */
const readsPlaybooks = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  readsAsThreadCaller(
    "A playbook tool",
    spawnAndBrief("read or run the playbook, since playbooks live in an agent's workspace"),
    handle,
  );

export const playbookHandlers = {
  j5_playbook_save: runsPlaybook((input: PlaybookSaveRequest) =>
    Effect.gen(function* () {
      const threadId = yield* ownerScope;
      const caller = yield* readCaller();
      const assignment = caller.caller?.agentPersonaAssignment;
      const authorityPolicy =
        assignment && isAgentPersonaAuthorityPolicy(assignment.authorityPolicy)
          ? mapAgentPersonaPolicy(assignment.authorityPolicy)
          : undefined;
      if (
        caller.limits.interactionMode === "plan" ||
        (assignment &&
          assignment.runtimeModeOverride !== "full-access" &&
          authorityPolicy !== "workspace-write" &&
          authorityPolicy !== "full-access")
      )
        return yield* playbookError(
          "capability_denied",
          "This agent's runtime policy cannot save playbook definitions. Use Save YAML in Settings or a writing agent.",
        );
      return yield* (yield* PlaybookStore).saveDefinitionFromTurn(
        threadId,
        caller.scope.thread?.subagent ? null : (caller.caller?.activeRunId ?? null),
        input,
      );
    }),
  ),
  j5_playbook_list: readsPlaybooks(() =>
    Effect.gen(function* () {
      const { root } = yield* workspace;
      return yield* (yield* PlaybookStore).discover(root);
    }),
  ),
  j5_playbook_read: readsPlaybooks((input: typeof Read.Type) =>
    Effect.gen(function* () {
      const { root } = yield* workspace;
      return yield* (yield* PlaybookStore).read(root, input.name);
    }),
  ),
  j5_playbook_start: runsPlaybook((input: typeof Start.Type) =>
    Effect.gen(function* () {
      const { owner, root } = yield* workspace;
      return yield* (yield* PlaybookCrewRelay).start({
        owner,
        root,
        name: input.name,
        key: input.client_request_id,
        ...(input.assignee === undefined ? {} : { assignee: input.assignee }),
      });
    }),
  ),
  j5_playbook_current: readsPlaybooks((input: typeof Current.Type) =>
    Effect.gen(function* () {
      return yield* (yield* PlaybookCrewRelay).current(yield* ownerScope, input.runId);
    }),
  ),
  j5_playbook_next: runsPlaybook((input: typeof Next.Type) =>
    mutate({ ...input, operation: "next" }),
  ),
  j5_playbook_back: runsPlaybook((input: typeof Movement.Type) =>
    mutate({ ...input, operation: "back" }),
  ),
  j5_playbook_revise: runsPlaybook((input: PlaybookReviseRequest) =>
    mutate({ ...input, operation: "revise" }),
  ),
  j5_playbook_assign: runsPlaybook((input: typeof Movement.Type) =>
    mutate({ ...input, operation: "assign" }),
  ),
  j5_playbook_complete: runsPlaybook((input: typeof Finish.Type) =>
    mutate({ ...input, operation: "complete" }),
  ),
  j5_playbook_cancel: runsPlaybook((input: typeof Mutation.Type) =>
    mutate({ ...input, operation: "cancel" }),
  ),
};
