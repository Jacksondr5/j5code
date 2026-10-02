import type {
  CommandId,
  MessageId,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import {
  CommandReceiptStoreV2,
  layerFromApplicationReceipts as commandReceiptStoreLayer,
} from "../../orchestration-v2/CommandReceiptStore.ts";
import {
  type ThreadLaunchError,
  ThreadLaunchService,
} from "../../orchestration-v2/ThreadLaunchService.ts";
import type { OrchestratorV2Error } from "../../orchestration-v2/Orchestrator.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { lifecycleCommandId, type SpawnStableInput } from "./spawnIds.ts";

/**
 * A branch or ref a caller names for a worktree. Git takes it as a positional argument, so a
 * leading dash would be read as an option; whitespace and control characters are never valid.
 */
const GIT_REF_PATTERN = /^[^-\s\p{Cc}][^\s\p{Cc}]*$/u;
const GIT_REF_MESSAGE =
  "A git ref must not start with '-' or contain whitespace or control characters";

export const GitRefName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(255),
  Schema.isPattern(GIT_REF_PATTERN, { message: GIT_REF_MESSAGE }),
);

/**
 * Where a spawned thread works, as a caller asks for it: the caller's own checkout (`shared`), or
 * a fresh worktree that upstream's ThreadLaunch prepares before the brief starts. Stored on Crew
 * seats in this camelCase form; omitted means the default for the door it came through.
 */
export const SpawnWorkspaceChoice = Schema.Union([
  Schema.Struct({ type: Schema.Literal("shared") }),
  Schema.Struct({
    type: Schema.Literal("worktree"),
    baseRef: Schema.optionalKey(GitRefName),
    branch: Schema.optionalKey(GitRefName),
    startFromOrigin: Schema.optionalKey(Schema.Boolean),
  }),
]);
export type SpawnWorkspaceChoice = typeof SpawnWorkspaceChoice.Type;

export type ResolvedSpawnWorkspace =
  | { readonly type: "shared" }
  | {
      readonly type: "worktree";
      readonly baseRef: string;
      readonly branch?: string;
      readonly startFromOrigin: boolean;
    };

/** What the caller's checkout looks like to git, read once per spawn or Crew roster. */
export interface SpawnCheckout {
  readonly inWorktree: boolean;
  readonly isRepo: boolean;
  /** The branch checked out where the caller works; null when detached or not a repository. */
  readonly refName: string | null;
  readonly localBranchNames: ReadonlyArray<string>;
  /** Why git could not be read, so an explicit worktree request can say so. */
  readonly problem: string | null;
}

export class SpawnWorkspaceError extends Data.TaggedError("SpawnWorkspaceError")<{
  readonly detail: string;
  readonly nextStep: string;
}> {
  override get message(): string {
    return this.detail;
  }
}

/**
 * The default and the checks for one choice. spawn_agent is the door for independent work, so it
 * defaults to a worktree wherever git can make one. A Crew seat defaults to its Captain's checkout
 * when the Captain already works in a worktree, which exists for this task and lets reviewers see
 * the builder's uncommitted work; a Captain on the project root gets a worktree per seat, so
 * nothing writes into the person's own checkout by default.
 */
export const resolveSpawnWorkspace = (
  checkout: SpawnCheckout,
  choice: SpawnWorkspaceChoice | undefined,
  door: "spawn" | "seat",
): Result.Result<ResolvedSpawnWorkspace, SpawnWorkspaceError> => {
  if (choice?.type === "shared") return Result.succeed({ type: "shared" });
  // Checked here as well as in the schemas: the person's card edits arrive through the client
  // contract, which doesn't constrain refs, and every door resolves through this function.
  const badRef = [choice?.baseRef, choice?.branch].find(
    (ref) => ref !== undefined && (ref.length > 255 || !GIT_REF_PATTERN.test(ref)),
  );
  if (badRef !== undefined)
    return Result.fail(
      new SpawnWorkspaceError({
        detail: `${GIT_REF_MESSAGE}: ${JSON.stringify(badRef)}.`,
        nextStep:
          "Name an existing branch or ref for base_ref, and a plain branch name for branch.",
      }),
    );
  if (choice === undefined) {
    if ((door === "seat" && checkout.inWorktree) || !checkout.isRepo || checkout.refName === null)
      return Result.succeed({ type: "shared" });
    return Result.succeed({ type: "worktree", baseRef: checkout.refName, startFromOrigin: false });
  }
  if (!checkout.isRepo)
    return Result.fail(
      new SpawnWorkspaceError({
        detail: `A worktree was requested, but the caller's checkout is not a git repository${checkout.problem === null ? "" : ` (${checkout.problem})`}.`,
        nextStep: 'Use workspace {"type":"shared"} to work in the caller\'s checkout.',
      }),
    );
  const baseRef = choice.baseRef ?? checkout.refName;
  if (baseRef === null)
    return Result.fail(
      new SpawnWorkspaceError({
        detail:
          "A worktree was requested, but the caller's checkout has no current branch (detached HEAD?).",
        nextStep: 'Pass workspace.base_ref, or use workspace {"type":"shared"}.',
      }),
    );
  if (choice.branch !== undefined && checkout.localBranchNames.includes(choice.branch))
    return Result.fail(
      new SpawnWorkspaceError({
        detail: `Branch '${choice.branch}' already exists.`,
        nextStep:
          "Choose a different workspace.branch, or omit it and let the server name the branch.",
      }),
    );
  return Result.succeed({
    type: "worktree",
    baseRef,
    ...(choice.branch === undefined ? {} : { branch: choice.branch }),
    startFromOrigin: choice.startFromOrigin ?? false,
  });
};

/**
 * A request key is bound to the workspace it was first accepted with: the create command id
 * encodes the choice. Shared keeps the original id, so spawns already in flight still replay.
 */
export const spawnCreateCommandId = (
  stableInput: SpawnStableInput,
  workspace: ResolvedSpawnWorkspace["type"],
): CommandId =>
  lifecycleCommandId({
    ...stableInput,
    operation: workspace === "shared" ? "spawn-create" : "spawn-create-worktree",
  });

/** The new thread's binding at creation: the caller's checkout, or none until ThreadLaunch sets it. */
export const spawnThreadCheckout = (
  workspace: ResolvedSpawnWorkspace,
  caller: { readonly branch: string | null; readonly worktreePath: string | null },
) =>
  workspace.type === "shared"
    ? { branch: caller.branch, worktreePath: caller.worktreePath }
    : { branch: null, worktreePath: null };

export interface StartSpawnBriefInput {
  readonly workspace: ResolvedSpawnWorkspace;
  readonly stableInput: SpawnStableInput;
  readonly squadronId: string;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly messageId: MessageId;
  readonly text: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface SpawnWorkspaceServiceShape {
  /** Reads git once for the caller's checkout; a failed read only rules out a worktree. */
  readonly inspect: (caller: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
    readonly listBranches: boolean;
  }) => Effect.Effect<SpawnCheckout>;
  /**
   * Runs one spawn's start (create, facts, brief) with no other start for the same thread in
   * flight, after refusing a request key already accepted with the other workspace type.
   *
   * Invariant: every door that dispatches `thread.create` for a spawn thread id goes through this
   * permit. The orchestrator has no existing-thread guard and the projection upserts, so a second
   * create under the other type's command id would overwrite the first thread; only this check,
   * made under the permit, keeps it from being dispatched. The receipt it reads is durable, so the
   * binding outlives the in-process permit across a restart.
   */
  readonly withSpawnStart: <A, E, R>(
    input: {
      readonly stableInput: SpawnStableInput;
      readonly threadId: ThreadId;
      readonly workspace: ResolvedSpawnWorkspace;
    },
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SpawnWorkspaceError, R>;
  /**
   * Starts the brief on a created, registered thread. Shared starts it now; a worktree hands the
   * thread to ThreadLaunch, which holds the brief as a preparing run until the worktree, branch
   * and setup script are ready, then releases it (or fails the run).
   */
  readonly startBrief: (
    input: StartSpawnBriefInput,
  ) => Effect.Effect<void, OrchestratorV2Error | ThreadLaunchError>;
}

export class SpawnWorkspaceService extends Context.Service<
  SpawnWorkspaceService,
  SpawnWorkspaceServiceShape
>()("t3/j5/a2a/spawnWorkspace/SpawnWorkspaceService") {}

const detailOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export interface SpawnWorkspaceOptions {
  /**
   * Runs once a start has queued behind another start of the same thread, and before it waits.
   * Tests use it to know the contender is held at the permit; production passes nothing.
   */
  readonly onStartQueued?: (threadId: ThreadId) => Effect.Effect<void>;
}

/**
 * One start per thread id at a time, first come first served. A key is present while a start
 * holds it, with the tickets of the starts queued behind it. A queued start can't pass until the
 * holder hands it the permit, which makes the queue a fact a test can wait on; an interrupted
 * waiter takes its ticket back.
 */
const makeStartPermits = (onQueued: (threadId: ThreadId) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const held = yield* Ref.make(new Map<ThreadId, ReadonlyArray<Deferred.Deferred<void>>>());
    const enter = (threadId: ThreadId, ticket: Deferred.Deferred<void>) =>
      Ref.modify(held, (current) => {
        const queue = current.get(threadId);
        const next = new Map(current);
        next.set(threadId, queue === undefined ? [] : [...queue, ticket]);
        return [queue !== undefined, next] as const;
      });
    const leave = (threadId: ThreadId, ticket: Deferred.Deferred<void>) =>
      Ref.modify(held, (current) => {
        const queue = current.get(threadId) ?? [];
        const next = new Map(current);
        // Still queued: this start never held the permit, so it only withdraws its ticket.
        if (queue.includes(ticket)) {
          next.set(
            threadId,
            queue.filter((waiting) => waiting !== ticket),
          );
          return [null, next] as const;
        }
        const [following, ...rest] = queue;
        if (following === undefined) next.delete(threadId);
        else next.set(threadId, rest);
        return [following ?? null, next] as const;
      }).pipe(
        Effect.flatMap((following) =>
          following === null ? Effect.void : Deferred.succeed(following, undefined),
        ),
      );
    return <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const ticket = yield* Deferred.make<void>();
        return yield* Effect.acquireUseRelease(
          enter(threadId, ticket),
          (queued) =>
            queued
              ? onQueued(threadId).pipe(
                  Effect.andThen(Deferred.await(ticket)),
                  Effect.andThen(effect),
                )
              : effect,
          () => leave(threadId, ticket),
        );
      });
  });

const make = (options: SpawnWorkspaceOptions) =>
  Effect.gen(function* () {
    const projects = yield* ProjectService;
    const git = yield* GitWorkflowService;
    const receipts = yield* CommandReceiptStoreV2;
    const launcher = yield* ThreadLaunchService;
    const threads = yield* ThreadManagementService;
    const withStartPermit = yield* makeStartPermits(options.onStartQueued ?? (() => Effect.void));

    const inspect: SpawnWorkspaceServiceShape["inspect"] = (caller) =>
      Effect.gen(function* () {
        const cwd =
          caller.worktreePath ??
          Option.getOrNull(yield* projects.getById(caller.projectId))?.workspaceRoot ??
          null;
        if (cwd === null) return yield* Effect.fail("the project is not readable");
        const status = yield* git.localStatus({ cwd });
        const localBranchNames =
          status.isRepo && caller.listBranches ? yield* git.listLocalBranchNames(cwd) : [];
        return {
          inWorktree: caller.worktreePath !== null,
          isRepo: status.isRepo,
          refName: status.refName,
          localBranchNames,
          problem: null,
        } satisfies SpawnCheckout;
      }).pipe(
        Effect.catch((cause) =>
          Effect.succeed({
            inWorktree: caller.worktreePath !== null,
            isRepo: false,
            refName: null,
            localBranchNames: [],
            problem: detailOf(cause),
          } satisfies SpawnCheckout),
        ),
      );

    const withSpawnStart: SpawnWorkspaceServiceShape["withSpawnStart"] = (input, effect) =>
      withStartPermit(
        input.threadId,
        Effect.gen(function* () {
          const other = input.workspace.type === "shared" ? "worktree" : "shared";
          const bound = yield* receipts
            .getByCommandId(spawnCreateCommandId(input.stableInput, other))
            .pipe(
              Effect.mapError(
                (error) =>
                  new SpawnWorkspaceError({
                    detail: `The spawn's earlier workspace choice could not be read: ${error.message}`,
                    nextStep: "Retry with the same client_request_id.",
                  }),
              ),
            );
          if (Option.isSome(bound))
            return yield* new SpawnWorkspaceError({
              detail: `client_request_id ${input.stableInput.requestKey} is already bound to a ${other} workspace.`,
              nextStep: `Retry with workspace {"type":"${other}"}, or use a fresh client_request_id.`,
            });
          return yield* effect;
        }),
      );

    const startBrief: SpawnWorkspaceServiceShape["startBrief"] = (input) =>
      input.workspace.type === "shared"
        ? threads
            .dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "mcp",
              commandId: lifecycleCommandId({ ...input.stableInput, operation: "spawn-brief" }),
              threadId: input.threadId,
              messageId: input.messageId,
              text: input.text,
              attachments: [],
              modelSelection: input.modelSelection,
              dispatchMode: { type: "start_immediately" },
            })
            .pipe(Effect.asVoid)
        : launcher
            .launch({
              commandId: lifecycleCommandId({ ...input.stableInput, operation: "spawn-launch" }),
              squadronId: input.squadronId,
              threadId: input.threadId,
              reuseExistingThread: true,
              projectId: input.projectId,
              title: input.title,
              modelSelection: input.modelSelection,
              runtimeMode: input.runtimeMode,
              interactionMode: input.interactionMode,
              workspaceStrategy: {
                type: "worktree",
                baseRef: input.workspace.baseRef,
                ...(input.workspace.branch === undefined ? {} : { branch: input.workspace.branch }),
                startFromOrigin: input.workspace.startFromOrigin,
              },
              initialMessage: { messageId: input.messageId, text: input.text, attachments: [] },
              createdBy: "agent",
              creationSource: "mcp",
            })
            .pipe(Effect.asVoid);

    return SpawnWorkspaceService.of({ inspect, withSpawnStart, startBrief });
  });

/** Takes the receipt store from its caller; tests provide their own. */
export const makeLayerFromReceiptStore = (options: SpawnWorkspaceOptions = {}) =>
  Layer.effect(SpawnWorkspaceService, make(options));

export const layerFromReceiptStore = makeLayerFromReceiptStore();

/** The receipt store is a stateless reader over the shared receipt table, built here for J5. */
export const layer = layerFromReceiptStore.pipe(Layer.provide(commandReceiptStoreLayer));
