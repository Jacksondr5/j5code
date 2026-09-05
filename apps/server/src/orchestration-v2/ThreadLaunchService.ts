import {
  CommandId,
  type ChatAttachment,
  type MessageId,
  type ModelSelection,
  type OrchestrationV2Actor,
  type OrchestrationV2AgentPersonaAssignment,
  type OrchestrationV2AgentPersonaRequest,
  type OrchestrationV2CreationSource,
  type OrchestrationV2ThreadProjection,
  type PlanId,
  type ProviderInteractionMode,
  ProjectId,
  type RunId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { buildTemporaryWorktreeBranchName, isTemporaryWorktreeBranch } from "@t3tools/shared/git";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { SquadronThreadCreationService } from "../j5/a2a/SquadronThreadCreationService.ts";
import { resolveSquadronLaunchPolicy } from "../j5/a2a/SquadronLaunchPolicy.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { buildBuiltInAgentPersonaAssignment } from "../j5/agents/agentPersonaAssignment.ts";
import { getBuiltInAgentPersona } from "../j5/agents/agentPersonas.ts";
import {
  resolveBuiltInAgentPersonaRoute,
  unavailableAgentPersonaReason,
} from "../j5/agents/agentPersonaRouting.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as IdAllocator from "./IdAllocator.ts";
import { makeProviderFailure } from "./ProviderFailure.ts";
import { randomUuidV4 } from "./RandomUuid.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export type ThreadLaunchWorkspaceStrategy =
  | { readonly type: "root"; readonly branch?: string | undefined }
  | {
      readonly type: "existing_worktree";
      readonly worktreePath: string;
      readonly branch?: string | undefined;
    }
  | {
      readonly type: "worktree";
      readonly baseRef: string;
      readonly branch?: string | undefined;
      readonly startFromOrigin?: boolean | undefined;
    };

export interface ThreadLaunchInitialMessage {
  readonly messageId?: MessageId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}

export interface ThreadLaunchInput {
  readonly commandId: CommandId;
  readonly squadronId?: string;
  readonly threadId?: ThreadId;
  readonly reuseExistingThread?: boolean;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly generateTitle?: boolean;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly agentPersona?: OrchestrationV2AgentPersonaRequest;
  readonly workspaceStrategy: ThreadLaunchWorkspaceStrategy;
  readonly initialMessage?: ThreadLaunchInitialMessage;
  /** Generic provenance for a child created from a proposed plan. */
  readonly sourcePlanRef?: { readonly threadId: ThreadId; readonly planId: PlanId };
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

export interface ThreadLaunchResult {
  readonly threadId: ThreadId;
  readonly projection: OrchestrationV2ThreadProjection;
  readonly resumed: boolean;
}

export class ThreadLaunchError extends Schema.TaggedErrorClass<ThreadLaunchError>()(
  "ThreadLaunchError",
  {
    operation: Schema.Literals([
      "resolve-project",
      "resolve-agent-persona",
      "read-receipt",
      "generate-metadata",
      "provision-worktree",
      "run-setup-script",
      "create-thread",
      "update-thread",
      "dispatch-message",
      "release-run",
      "fail-run",
      "register-squadron",
    ]),
    commandId: CommandId,
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    if (this.operation === "register-squadron" && this.threadId !== undefined) {
      return `Thread ${this.threadId} was created but could not be assigned its required Squadron home. Replay the same creation command to retry registration; the durable thread was not deleted.`;
    }
    if (this.operation === "resolve-agent-persona") {
      return this.cause instanceof Error ? this.cause.message : String(this.cause);
    }
    return `Thread launch ${this.commandId} failed during ${this.operation}.`;
  }
}

export class ThreadLaunchService extends Context.Service<
  ThreadLaunchService,
  {
    readonly launch: (
      input: ThreadLaunchInput,
    ) => Effect.Effect<ThreadLaunchResult, ThreadLaunchError>;
  }
>()("t3/orchestration-v2/ThreadLaunchService") {}

const isThreadLaunchError = Schema.is(ThreadLaunchError);

function failureDetail(error: unknown): string {
  if (isThreadLaunchError(error)) {
    const cause = error.cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    return `Workspace preparation failed during ${error.operation.replaceAll("-", " ")}: ${detail}`;
  }
  return `Workspace preparation failed: ${error instanceof Error ? error.message : String(error)}`;
}

export const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const git = yield* GitWorkflow.GitWorkflowService;
  const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const squadronCreation = yield* SquadronThreadCreationService;
  const preparationScope = yield* Scope.make("sequential");
  const scheduledLaunches = yield* Ref.make<ReadonlySet<CommandId>>(new Set());
  yield* Effect.addFinalizer(() => Scope.close(preparationScope, Exit.void));

  const mapError =
    (input: ThreadLaunchInput, operation: ThreadLaunchError["operation"], threadId?: ThreadId) =>
    (cause: unknown) =>
      new ThreadLaunchError({
        operation,
        commandId: input.commandId,
        projectId: input.projectId,
        ...(threadId === undefined ? {} : { threadId }),
        cause,
      });

  const readReceipt = (input: ThreadLaunchInput, commandId: CommandId) =>
    receipts
      .getByCommandId(commandId)
      .pipe(Effect.mapError(mapError(input, "read-receipt", input.threadId)));

  const validateReusableThread = Effect.fn("ThreadLaunchService.validateReusableThread")(function* (
    input: ThreadLaunchInput,
    threadId: ThreadId,
  ) {
    const projection = yield* threads
      .getThreadProjection(threadId)
      .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));
    if (
      projection.thread.projectId !== input.projectId ||
      projection.thread.archivedAt !== null ||
      projection.thread.deletedAt !== null ||
      projection.messages.length > 0 ||
      projection.runs.length > 0
    ) {
      return yield* mapError(
        input,
        "update-thread",
        threadId,
      )("Only an empty active thread in the target project can change workspace during launch.");
    }
  });

  const prepareInBackground = Effect.fn("ThreadLaunchService.prepareInBackground")(function* (
    input: ThreadLaunchInput,
    threadId: ThreadId,
    runId: RunId | null,
  ) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError(mapError(input, "resolve-project", threadId)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(mapError(input, "resolve-project", threadId)("Project no longer exists.")),
          onSome: Effect.succeed,
        }),
      ),
    );

    const initialMessage = input.initialMessage;
    const generateBranchNameFor = (cwd: string, message: ThreadLaunchInitialMessage) =>
      Effect.gen(function* () {
        const settings = yield* serverSettings.getSettings;
        const modelSelection =
          settings.sourceControlWriterModelSelection === null
            ? settings.textGenerationModelSelection
            : ServerSettings.resolveSourceControlWriterModelSelection(
                settings,
                yield* providerRegistry.getProviders,
              );
        return yield* textGeneration
          .generateBranchName({
            cwd,
            message: message.text,
            attachments: message.attachments,
            modelSelection,
          })
          .pipe(Effect.map((result) => result.branch));
      });

    // The server owns worktree naming: without an explicit branch, provision
    // under a temporary `t3code/<hash>` name so the worktree never waits on
    // name generation, then rename in the background below.
    const requestedBranch = input.workspaceStrategy.branch;
    let branch: string | null;
    if (input.workspaceStrategy.type === "worktree" && requestedBranch === undefined) {
      const uuid = yield* randomUuidV4;
      branch = buildTemporaryWorktreeBranchName(() => uuid.replaceAll("-", ""));
    } else {
      branch = requestedBranch ?? null;
    }
    let worktreePath =
      input.workspaceStrategy.type === "existing_worktree"
        ? input.workspaceStrategy.worktreePath
        : null;
    if (input.workspaceStrategy.type === "worktree") {
      if (runId !== null) {
        yield* threads
          .dispatch({
            type: "prepared-run.progress",
            commandId: CommandId.make(`${input.commandId}:progress:worktree`),
            threadId,
            runId,
            phase: "worktree",
          })
          .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));
      }
      let startRef = input.workspaceStrategy.baseRef;
      if (input.workspaceStrategy.startFromOrigin === true) {
        yield* git
          .fetchRemote({ cwd: project.workspaceRoot, remoteName: "origin" })
          .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)));
        startRef = yield* git
          .resolveRemoteTrackingCommit({
            cwd: project.workspaceRoot,
            refName: input.workspaceStrategy.baseRef,
            fallbackRemoteName: "origin",
          })
          .pipe(
            Effect.map((resolved) => resolved.commitSha),
            Effect.mapError(mapError(input, "provision-worktree", threadId)),
          );
      }
      const worktree = yield* git
        .createWorktree({
          cwd: project.workspaceRoot,
          refName: startRef,
          newRefName: branch!,
          baseRefName: input.workspaceStrategy.baseRef,
          path: null,
        })
        .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)));
      worktreePath = worktree.worktree.path;
      branch = worktree.worktree.refName;
    }

    yield* threads
      .dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`${input.commandId}:workspace`),
        threadId,
        branch,
        worktreePath,
      })
      .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));

    // Rename temporary branches (server-invented above, or sent by clients
    // that name worktrees themselves) in the background so generation latency
    // never delays provisioning or the provider turn. The temporary name
    // simply sticks if generation or the rename fails.
    if (
      worktreePath !== null &&
      branch !== null &&
      initialMessage !== undefined &&
      isTemporaryWorktreeBranch(branch)
    ) {
      const oldBranch = branch;
      const worktreeCwd = worktreePath;
      yield* generateBranchNameFor(worktreeCwd, initialMessage).pipe(
        Effect.flatMap((newBranch) => git.renameBranch({ cwd: worktreeCwd, oldBranch, newBranch })),
        Effect.flatMap((renamed) =>
          threads.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`${input.commandId}:branch-rename`),
            threadId,
            branch: renamed.branch,
            worktreePath: worktreeCwd,
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Thread worktree branch rename failed", {
            commandId: input.commandId,
            threadId,
            oldBranch,
            cause,
          }),
        ),
        Effect.forkIn(preparationScope),
      );
    }

    const cwd = worktreePath ?? project.workspaceRoot;
    if (runId !== null) {
      yield* threads
        .dispatch({
          type: "prepared-run.progress",
          commandId: CommandId.make(`${input.commandId}:progress:setup`),
          threadId,
          runId,
          phase: "setup",
        })
        .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));
    }
    yield* setupScripts
      .runForThread({
        threadId,
        projectId: input.projectId,
        projectCwd: project.workspaceRoot,
        worktreePath: cwd,
        project: {
          workspaceRoot: project.workspaceRoot,
          scripts: project.scripts,
        },
      })
      .pipe(Effect.mapError(mapError(input, "run-setup-script", threadId)));

    if (runId !== null) {
      yield* threads
        .dispatch({
          type: "prepared-run.release",
          commandId: CommandId.make(`${input.commandId}:release`),
          threadId,
          runId,
        })
        .pipe(Effect.mapError(mapError(input, "release-run", threadId)));
    }
  });

  const failPreparedRun = (
    input: ThreadLaunchInput,
    threadId: ThreadId,
    runId: RunId | null,
    cause: unknown,
  ) =>
    runId === null
      ? Effect.logWarning("Thread workspace preparation failed", {
          commandId: input.commandId,
          threadId,
          cause,
        })
      : threads
          .dispatch({
            type: "prepared-run.fail",
            commandId: CommandId.make(`${input.commandId}:fail`),
            threadId,
            runId,
            failure: makeProviderFailure({
              cause,
              message: failureDetail(cause),
              class: "validation_error",
              retryable: false,
            }),
          })
          .pipe(
            Effect.mapError(mapError(input, "fail-run", threadId)),
            Effect.catchCause((persistCause) =>
              Effect.logWarning("Failed to persist thread workspace preparation failure", {
                commandId: input.commandId,
                threadId,
                cause,
                persistCause,
              }),
            ),
          );

  const reservePreparation = (commandId: CommandId) =>
    Ref.modify(scheduledLaunches, (scheduled) => {
      if (scheduled.has(commandId)) return [false, scheduled] as const;
      const next = new Set(scheduled);
      next.add(commandId);
      return [true, next] as const;
    });

  const releasePreparation = (commandId: CommandId) =>
    Ref.update(scheduledLaunches, (scheduled) => {
      const next = new Set(scheduled);
      next.delete(commandId);
      return next;
    });

  const schedulePreparation = Effect.fn("ThreadLaunchService.schedulePreparation")(function* (
    input: ThreadLaunchInput,
    threadId: ThreadId,
    runId: RunId | null,
  ) {
    yield* prepareInBackground(input, threadId, runId).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : failPreparedRun(input, threadId, runId, Cause.squash(cause)),
      ),
      Effect.ensuring(releasePreparation(input.commandId)),
      Effect.forkIn(preparationScope),
    );
  });

  const launch: ThreadLaunchService["Service"]["launch"] = Effect.fn("ThreadLaunchService.launch")(
    function* (input) {
      const project = yield* projects.getById(input.projectId).pipe(
        Effect.mapError(mapError(input, "resolve-project")),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(mapError(input, "resolve-project")("Project not found.")),
            onSome: Effect.succeed,
          }),
        ),
      );
      if (input.reuseExistingThread === true && input.threadId === undefined) {
        return yield* mapError(
          input,
          "update-thread",
        )("Reusing an existing thread requires a thread id.");
      }
      if (input.reuseExistingThread === true && input.agentPersona !== undefined) {
        return yield* mapError(
          input,
          "resolve-agent-persona",
        )("Agent persona assignment requires a newly created thread.");
      }

      const launchReceipt = yield* readReceipt(input, input.commandId);
      let launchModelSelection = input.modelSelection;
      let agentPersonaAssignment: OrchestrationV2AgentPersonaAssignment | undefined;
      if (input.agentPersona !== undefined && Option.isNone(launchReceipt)) {
        const definition = getBuiltInAgentPersona(input.agentPersona.personaId);
        const requestedAuthorityPolicy = input.agentPersona.authorityPolicy;
        if (
          requestedAuthorityPolicy !== undefined &&
          !definition.authority.allowedPolicies.some(
            (policy) => policy === requestedAuthorityPolicy,
          )
        ) {
          return yield* mapError(
            input,
            "resolve-agent-persona",
          )(
            `Authority policy ${requestedAuthorityPolicy} is not allowed for ${input.agentPersona.personaId}.`,
          );
        }
        const resolution = resolveBuiltInAgentPersonaRoute({
          personaId: input.agentPersona.personaId,
          providers: yield* providerRegistry.getProviders,
          ...(input.agentPersona.authorityPolicy === undefined
            ? {}
            : { authorityPolicy: input.agentPersona.authorityPolicy }),
        });
        if (resolution.status === "unavailable") {
          const reason = unavailableAgentPersonaReason(resolution);
          return yield* mapError(
            input,
            "resolve-agent-persona",
          )(
            reason === "authority-not-enforceable"
              ? `Agent persona ${input.agentPersona.personaId} is blocked because neither route can enforce its authority policy.`
              : `Agent persona ${input.agentPersona.personaId} is blocked because its primary and fallback models are unavailable.`,
          );
        }
        const assignment = buildBuiltInAgentPersonaAssignment({
          resolution,
          ...(input.agentPersona.authorityPolicy === undefined
            ? {}
            : { authorityPolicy: input.agentPersona.authorityPolicy }),
        });
        if (assignment.status === "invalid-authority-policy") {
          return yield* mapError(
            input,
            "resolve-agent-persona",
          )(
            `Authority policy ${assignment.requestedPolicy} is not allowed for ${assignment.personaId}.`,
          );
        }
        if (assignment.status === "authority-not-enforceable") {
          return yield* mapError(
            input,
            "resolve-agent-persona",
          )(
            `Agent persona ${assignment.personaId} is blocked because ${assignment.driver} cannot enforce ${assignment.requestedPolicy} authority.`,
          );
        }
        agentPersonaAssignment = assignment.assignment;
        launchModelSelection = assignment.assignment.resolvedModelSelection;
      }
      return yield* Effect.gen(function* () {
        const candidateThreadId =
          input.threadId ??
          (yield* ids.allocate
            .thread({ projectId: input.projectId })
            .pipe(Effect.mapError(mapError(input, "create-thread"))));

        if (input.reuseExistingThread === true && Option.isNone(launchReceipt)) {
          yield* validateReusableThread(input, candidateThreadId);
        }

        const initialBranch = input.workspaceStrategy.branch ?? null;
        const initialWorktreePath =
          input.workspaceStrategy.type === "existing_worktree"
            ? input.workspaceStrategy.worktreePath
            : null;
        const claimDispatch =
          input.reuseExistingThread === true
            ? threads.dispatch({
                type: "thread.metadata.update",
                commandId: input.commandId,
                threadId: candidateThreadId,
              })
            : threads.dispatch({
                type: "thread.create",
                commandId: input.commandId,
                threadId: candidateThreadId,
                projectId: input.projectId,
                title: input.title,
                modelSelection: launchModelSelection,
                runtimeMode: input.runtimeMode,
                interactionMode: input.interactionMode,
                ...(agentPersonaAssignment === undefined ? {} : { agentPersonaAssignment }),
                branch: initialBranch,
                worktreePath: initialWorktreePath,
                createdBy: input.createdBy,
                creationSource: input.creationSource,
              });
        const claimed = yield* claimDispatch.pipe(
          Effect.mapError(
            mapError(
              input,
              input.reuseExistingThread === true ? "update-thread" : "create-thread",
              candidateThreadId,
            ),
          ),
        );
        const threadId =
          claimed.storedEvents.find((stored) => stored.event.type.startsWith("thread."))?.event
            .threadId ?? candidateThreadId;
        const durableThread = claimed.storedEvents.find(
          (stored) => stored.event.type === "thread.created",
        );
        const durableModelSelection =
          durableThread?.event.type === "thread.created"
            ? durableThread.event.payload.modelSelection
            : launchModelSelection;
        if (project.id !== input.projectId) {
          return yield* mapError(input, "resolve-project", threadId)("Project identity changed.");
        }

        let runId: RunId | null = null;
        let messageWasAlreadyAccepted = false;
        if (input.initialMessage !== undefined) {
          const messageCommandId = CommandId.make(`${input.commandId}:initial-message`);
          const messageReceipt = yield* readReceipt(input, messageCommandId);
          messageWasAlreadyAccepted = Option.isSome(messageReceipt);
          const messageId =
            input.initialMessage.messageId ??
            (yield* ids.allocate
              .message({ threadId, ordinal: 1 })
              .pipe(Effect.mapError(mapError(input, "dispatch-message", threadId))));
          const dispatched = yield* threads
            .dispatch({
              type: "message.dispatch",
              commandId: messageCommandId,
              threadId,
              messageId,
              text: input.initialMessage.text,
              attachments: input.initialMessage.attachments,
              ...(input.generateTitle === true ? { titleSeed: input.title } : {}),
              modelSelection: durableModelSelection,
              dispatchMode: { type: "defer_start" },
              createdBy: input.createdBy,
              creationSource: input.creationSource,
            })
            .pipe(Effect.mapError(mapError(input, "dispatch-message", threadId)));
          const runCreated = dispatched.storedEvents.find(
            (stored) => stored.event.type === "run.created",
          );
          runId = runCreated?.event.type === "run.created" ? runCreated.event.payload.id : null;
          if (runId === null) {
            return yield* mapError(
              input,
              "dispatch-message",
              threadId,
            )("Initial message was accepted without a durable run.");
          }
        }

        const projection = yield* threads
          .getThreadProjection(threadId)
          .pipe(Effect.mapError(mapError(input, "create-thread", threadId)));
        const parentHomeResult =
          input.sourcePlanRef === undefined
            ? null
            : yield* Effect.result(
                squadronCreation.findRegisteredHome(input.sourcePlanRef.threadId),
              );
        if (parentHomeResult !== null && Result.isFailure(parentHomeResult)) {
          return yield* failPreparedRun(input, threadId, runId, parentHomeResult.failure).pipe(
            Effect.andThen(() =>
              Effect.fail(mapError(input, "register-squadron", threadId)(parentHomeResult.failure)),
            ),
          );
        }
        const inheritedSquadronId =
          parentHomeResult === null || Result.isFailure(parentHomeResult)
            ? undefined
            : (parentHomeResult.success?.squadronId ?? undefined);
        const squadronPolicy = resolveSquadronLaunchPolicy({
          createdBy: input.createdBy,
          creationSource: input.creationSource,
          hasInitialMessage: input.initialMessage !== undefined,
          sourcePlanHasRegisteredHome:
            input.sourcePlanRef === undefined ? null : inheritedSquadronId !== undefined,
        });
        if (squadronPolicy.kind === "require-squadron") {
          const squadronCreationInput = {
            ...(inheritedSquadronId === undefined && input.squadronId === undefined
              ? {}
              : { squadronId: inheritedSquadronId ?? input.squadronId }),
            commandId: input.commandId,
            threadId,
            projectId: input.projectId,
            createdAt: DateTime.formatIso(projection.thread.createdAt),
          };
          const registration = yield* Effect.result(
            squadronCreation.registerAtDurableLaunch(squadronCreationInput),
          );
          if (Result.isFailure(registration)) {
            return yield* failPreparedRun(input, threadId, runId, registration.failure).pipe(
              Effect.andThen(() =>
                Effect.fail(mapError(input, "register-squadron", threadId)(registration.failure)),
              ),
            );
          }
        }
        const runIsPreparing =
          runId !== null &&
          projection.runs.some((run) => run.id === runId && run.status === "preparing");
        const shouldSchedule = runId === null ? Option.isNone(launchReceipt) : runIsPreparing;
        if (shouldSchedule) {
          const ownsPreparation = yield* reservePreparation(input.commandId);
          if (ownsPreparation) {
            yield* Effect.gen(function* () {
              const preparationStillRequired =
                runId === null
                  ? true
                  : yield* threads.getThreadProjection(threadId).pipe(
                      Effect.map((current) =>
                        current.runs.some((run) => run.id === runId && run.status === "preparing"),
                      ),
                      Effect.mapError(mapError(input, "update-thread", threadId)),
                    );
              if (preparationStillRequired) {
                yield* schedulePreparation(input, threadId, runId);
              } else {
                yield* releasePreparation(input.commandId);
              }
            }).pipe(Effect.onError(() => releasePreparation(input.commandId)));
          }
        }

        return {
          threadId,
          projection,
          resumed: Option.isSome(launchReceipt) || messageWasAlreadyAccepted,
        };
      });
    },
  );

  return ThreadLaunchService.of({ launch });
});

export const layer = Layer.effect(ThreadLaunchService, make);
