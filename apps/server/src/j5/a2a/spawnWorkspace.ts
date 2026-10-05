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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
import { lifecycleCommandId, spawnThreadId, type SpawnStableInput } from "./spawnIds.ts";
import { spawnWorktreeCreateCommandId } from "./spawnWorktreeTurns.ts";

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

/** A worktree path with its trailing separators dropped, so `/repo/wt/` matches git's `/repo/wt`. */
const worktreePathKey = (path: string) => path.replace(/[\\/]+$/, "");

/** An absolute path a caller names for an existing worktree. */
export const WorktreePath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));

/**
 * Where a spawned thread works, as the caller chose it; there is no default. `shared` is the
 * caller's own checkout, `worktree` a new worktree that upstream's ThreadLaunch prepares from
 * `baseRef` before the brief starts, and `existing_worktree` one of the project's worktrees that
 * already exists. Stored on Crew seats in this camelCase form.
 */
export const SpawnWorkspaceChoice = Schema.Union([
  Schema.Struct({ type: Schema.Literal("shared") }),
  Schema.Struct({
    type: Schema.Literal("worktree"),
    baseRef: GitRefName,
    branch: Schema.optionalKey(GitRefName),
    startFromOrigin: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal("existing_worktree"), worktreePath: WorktreePath }),
]);
export type SpawnWorkspaceChoice = typeof SpawnWorkspaceChoice.Type;

export type ResolvedSpawnWorkspace =
  | { readonly type: "shared" }
  | {
      readonly type: "worktree";
      readonly baseRef: string;
      readonly branch?: string;
      readonly startFromOrigin: boolean;
    }
  | { readonly type: "existing_worktree"; readonly worktreePath: string; readonly branch: string };

/** A base ref as a caller named it; from origin, its fetched remote-tracking copy also counts. */
export interface SpawnBaseRef {
  readonly ref: string;
  readonly startFromOrigin: boolean;
}

/** The base refs a set of choices name, for `inspect` to verify. */
export const namedBaseRefs = (
  choices: ReadonlyArray<SpawnWorkspaceChoice>,
): ReadonlyArray<SpawnBaseRef> =>
  choices.flatMap((choice) =>
    choice.type === "worktree"
      ? [{ ref: choice.baseRef, startFromOrigin: choice.startFromOrigin ?? false }]
      : [],
  );

/** A worktree of the project other than its main checkout, with the branch git has there. */
export interface ProjectWorktree {
  readonly path: string;
  readonly branch: string;
}

/**
 * The project's repository as git reports it, read once per spawn or Crew roster, or why it
 * couldn't be read. A choice that needs git is refused when it can't be read.
 */
export type SpawnCheckout =
  | {
      readonly readable: true;
      /** The branch checked out where the caller works; null when detached. */
      readonly currentBranch: string | null;
      /** The first page of local branches; `branchesTruncated` says whether there are more. */
      readonly branches: ReadonlyArray<string>;
      readonly branchesTruncated: boolean;
      readonly worktrees: ReadonlyArray<ProjectWorktree>;
      /** Every local branch, read only when a choice names a new branch to check against. */
      readonly localBranchNames: ReadonlyArray<string>;
      /** Base refs a caller named that git can't resolve to a commit, as they were asked for. */
      readonly missingBaseRefs: ReadonlyArray<SpawnBaseRef>;
    }
  | { readonly readable: false; readonly problem: string };

export class SpawnWorkspaceError extends Data.TaggedError("SpawnWorkspaceError")<{
  readonly detail: string;
  readonly nextStep: string;
}> {
  override get message(): string {
    return this.detail;
  }
}

/** The checks for one explicit choice. Only `shared` needs nothing from git. */
export const resolveSpawnWorkspace = (
  checkout: SpawnCheckout,
  choice: SpawnWorkspaceChoice,
): Result.Result<ResolvedSpawnWorkspace, SpawnWorkspaceError> => {
  if (choice.type === "shared") return Result.succeed({ type: "shared" });
  // Checked here as well as in the schemas: the person's card edits arrive through the client
  // contract, which doesn't constrain refs, and every door resolves through this function.
  const badRef =
    choice.type === "worktree"
      ? [choice.baseRef, choice.branch].find(
          (ref) => ref !== undefined && (ref.length > 255 || !GIT_REF_PATTERN.test(ref)),
        )
      : undefined;
  if (badRef !== undefined)
    return Result.fail(
      new SpawnWorkspaceError({
        detail: `${GIT_REF_MESSAGE}: ${JSON.stringify(badRef)}.`,
        nextStep:
          "Name an existing branch or ref for base_ref, and a plain branch name for branch.",
      }),
    );
  if (!checkout.readable)
    return Result.fail(
      new SpawnWorkspaceError({
        detail: `The project's git repository can't be read (${checkout.problem}), so no worktree can be used.`,
        nextStep: 'Retry once git can read the project, or use workspace {"type":"shared"}.',
      }),
    );
  if (choice.type === "existing_worktree") {
    const wanted = worktreePathKey(choice.worktreePath);
    const found = checkout.worktrees.find((worktree) => worktree.path === wanted);
    if (found === undefined)
      return Result.fail(
        new SpawnWorkspaceError({
          detail: `'${choice.worktreePath}' isn't one of this project's worktrees on a branch.${checkout.worktrees.length === 0 ? " The project has none." : ` Its worktrees: ${checkout.worktrees.map((worktree) => worktree.path).join(", ")}.`}`,
          nextStep: "Name one of those paths for workspace.worktree_path.",
        }),
      );
    return Result.succeed({
      type: "existing_worktree",
      worktreePath: found.path,
      branch: found.branch,
    });
  }
  if (
    checkout.missingBaseRefs.some(
      (missing) =>
        missing.ref === choice.baseRef &&
        missing.startFromOrigin === (choice.startFromOrigin ?? false),
    )
  )
    return Result.fail(
      new SpawnWorkspaceError({
        detail: `Base ref '${choice.baseRef}' doesn't resolve to a commit in this repository${choice.startFromOrigin === true ? ", locally or as a fetched origin branch" : ""}.`,
        nextStep: "Name an existing branch, tag, or commit for workspace.base_ref.",
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
    baseRef: choice.baseRef,
    ...(choice.branch === undefined ? {} : { branch: choice.branch }),
    startFromOrigin: choice.startFromOrigin ?? false,
  });
};

/**
 * A request key is bound to the workspace type it was first accepted with: the create command id
 * encodes the type. Shared keeps the original id, so spawns already in flight still replay.
 */
export const spawnCreateCommandId = (
  stableInput: SpawnStableInput,
  workspace: ResolvedSpawnWorkspace["type"],
): CommandId =>
  workspace === "shared"
    ? lifecycleCommandId({ ...stableInput, operation: "spawn-create" })
    : workspace === "existing_worktree"
      ? lifecycleCommandId({ ...stableInput, operation: "spawn-create-existing" })
      : // Keyed by the thread, so the turn guard can tell this thread asked for a new worktree.
        spawnWorktreeCreateCommandId(spawnThreadId(stableInput));

const WORKSPACE_TYPES = ["shared", "worktree", "existing_worktree"] as const;

/**
 * The new thread's binding at creation: the caller's checkout, the existing worktree and its
 * branch, or none until ThreadLaunch binds a new worktree.
 */
export const spawnThreadCheckout = (
  workspace: ResolvedSpawnWorkspace,
  caller: { readonly branch: string | null; readonly worktreePath: string | null },
) =>
  workspace.type === "shared"
    ? { branch: caller.branch, worktreePath: caller.worktreePath }
    : workspace.type === "existing_worktree"
      ? { branch: workspace.branch, worktreePath: workspace.worktreePath }
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
  /**
   * Reads the project's repository once, from where the caller works: its branches, its
   * worktrees, and whether the named base refs exist. Shared choices don't need it.
   */
  readonly inspect: (caller: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
    /** Read every local branch, to refuse a new branch name that exists. */
    readonly checkBranches: boolean;
    /** Base refs to check before anything is created (see `namedBaseRefs`). */
    readonly baseRefs: ReadonlyArray<SpawnBaseRef>;
  }) => Effect.Effect<SpawnCheckout>;
  /**
   * Runs one spawn's start (create, facts, brief), refusing it while another start for the same
   * thread is in flight, and refusing a request key already accepted with the other workspace type.
   *
   * Invariant: every door that dispatches `thread.create` for a spawn thread id goes through this.
   * The orchestrator has no existing-thread guard and the projection upserts, so a second create
   * under the other type's command id would overwrite the first thread. With one start in flight
   * per thread, the receipt check can't race the create it guards. The receipt is durable, so the
   * binding outlives the in-process guard across a restart.
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
   * Starts the brief on a created, registered thread. Shared and an existing worktree start it
   * now; a new worktree hands the thread to ThreadLaunch, which holds the brief as a preparing run until the worktree exists
   * and is bound, then releases it (or fails the run). The project's setup script starts before
   * the release but is awaited only when it asks to finish first, so the agent may begin while it
   * is still running.
   */
  readonly startBrief: (
    input: StartSpawnBriefInput,
  ) => Effect.Effect<void, OrchestratorV2Error | ThreadLaunchError>;
  /** Whether J5 created this thread to work in a worktree of its own. */
  readonly askedForWorktree: (threadId: ThreadId) => Effect.Effect<boolean, SpawnWorkspaceError>;
}

export class SpawnWorkspaceService extends Context.Service<
  SpawnWorkspaceService,
  SpawnWorkspaceServiceShape
>()("t3/j5/a2a/spawnWorkspace/SpawnWorkspaceService") {}

const detailOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Local branches a preview lists; more are summarized as truncated. */
const BRANCH_PAGE = 100;

const make = Effect.gen(function* () {
  const projects = yield* ProjectService;
  const git = yield* GitWorkflowService;
  const receipts = yield* CommandReceiptStoreV2;
  const launcher = yield* ThreadLaunchService;
  const threads = yield* ThreadManagementService;
  // Spawn threads with a start running in this process. A second start for one of them is
  // refused rather than queued: it would only replay the first, and retrying is safe.
  const startsInFlight = new Set<ThreadId>();

  const inspect: SpawnWorkspaceServiceShape["inspect"] = (caller) =>
    Effect.gen(function* () {
      const project = Option.getOrNull(yield* projects.getById(caller.projectId));
      if (project === null) return yield* Effect.fail("the project is not readable");
      const root = worktreePathKey(project.workspaceRoot);
      const cwd = caller.worktreePath ?? project.workspaceRoot;
      const first = yield* git.listRefs({ cwd, refKind: "local", limit: BRANCH_PAGE });
      if (!first.isRepo) return yield* Effect.fail("the project is not a git repository");
      // Pages come from one cached snapshot per repository, so reading every worktree is cheap.
      const refs = [...first.refs];
      for (let cursor = first.nextCursor; cursor !== null;) {
        const page = yield* git.listRefs({ cwd, refKind: "local", cursor, limit: 200 });
        refs.push(...page.refs);
        cursor = page.nextCursor;
      }
      const missingBaseRefs = yield* Effect.filter(caller.baseRefs, (base) =>
        git.hasCommit({ cwd, refName: base.ref }).pipe(
          Effect.flatMap((found) =>
            found || !base.startFromOrigin
              ? Effect.succeed(found)
              : git.hasCommit({ cwd, refName: `refs/remotes/origin/${base.ref}` }),
          ),
          Effect.map((found) => !found),
        ),
      );
      return {
        readable: true,
        currentBranch: first.refs.find((ref) => ref.current)?.name ?? null,
        branches: first.refs.map((ref) => ref.name),
        branchesTruncated: first.nextCursor !== null,
        // The main checkout is the person's own, not a worktree an agent is placed in.
        worktrees: refs.flatMap((ref) =>
          ref.worktreePath === null || worktreePathKey(ref.worktreePath) === root
            ? []
            : [{ path: worktreePathKey(ref.worktreePath), branch: ref.name }],
        ),
        localBranchNames: caller.checkBranches ? refs.map((ref) => ref.name) : [],
        missingBaseRefs,
      } satisfies SpawnCheckout;
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed({ readable: false, problem: detailOf(cause) } satisfies SpawnCheckout),
      ),
    );

  const withSpawnStart: SpawnWorkspaceServiceShape["withSpawnStart"] = (input, effect) =>
    // The check, the add, and the releasing finalizer run with no interruptible gap, so an
    // interrupt can't leak an entry and block every later start of this thread.
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        if (startsInFlight.has(input.threadId))
          return Effect.fail(
            new SpawnWorkspaceError({
              detail: `A start for client_request_id ${input.stableInput.requestKey} is already in progress.`,
              nextStep: "Retry with the same client_request_id once it returns.",
            }),
          );
        startsInFlight.add(input.threadId);
        return restore(
          Effect.gen(function* () {
            for (const other of WORKSPACE_TYPES) {
              if (other === input.workspace.type) continue;
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
                  detail: `client_request_id ${input.stableInput.requestKey} is already bound to workspace {"type":"${other}"}.`,
                  nextStep: `Retry with that workspace, or use a fresh client_request_id.`,
                });
            }
            return yield* effect;
          }),
        ).pipe(Effect.ensuring(Effect.sync(() => startsInFlight.delete(input.threadId))));
      }),
    );

  const startBrief: SpawnWorkspaceServiceShape["startBrief"] = (input) =>
    input.workspace.type !== "worktree"
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

  const askedForWorktree: SpawnWorkspaceServiceShape["askedForWorktree"] = (threadId) =>
    receipts.getByCommandId(spawnWorktreeCreateCommandId(threadId)).pipe(
      Effect.map((receipt) => Option.isSome(receipt) && receipt.value.status === "accepted"),
      Effect.mapError(
        (error) =>
          new SpawnWorkspaceError({
            detail: `Thread ${threadId}'s workspace request could not be read: ${error.message}`,
            nextStep: "Retry once the command receipts are readable.",
          }),
      ),
    );

  return SpawnWorkspaceService.of({ inspect, withSpawnStart, startBrief, askedForWorktree });
});

/** Takes the receipt store from its caller; tests provide their own. */
export const layerFromReceiptStore = Layer.effect(SpawnWorkspaceService, make);

/** The receipt store is a stateless reader over the shared receipt table, built here for J5. */
export const layer = layerFromReceiptStore.pipe(Layer.provide(commandReceiptStoreLayer));
