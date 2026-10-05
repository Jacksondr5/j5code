import type { CommandId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { GitWorkflowService } from "../../../git/GitWorkflowService.ts";
import { CommandReceiptStoreV2 } from "../../../orchestration-v2/CommandReceiptStore.ts";
import {
  ThreadLaunchService,
  type ThreadLaunchInput,
} from "../../../orchestration-v2/ThreadLaunchService.ts";
import { ProjectService } from "../../../project/ProjectService.ts";
import { layerFromReceiptStore } from "../spawnWorkspace.ts";

export interface FakeCheckout {
  readonly isRepo: boolean;
  /** The branch checked out where the caller works. */
  readonly refName: string | null;
  /** Other local branches; `refName` and the worktrees' branches are local too. */
  readonly localBranchNames?: ReadonlyArray<string>;
  /** Worktrees beside the main checkout at `/repo`, each on its branch. */
  readonly worktrees?: ReadonlyArray<{ readonly path: string; readonly branch: string }>;
  /** Refs git can't resolve; every other ref exists. */
  readonly missingRefs?: ReadonlyArray<string>;
}

/** A project that is not a git repository; only a shared choice can resolve there. */
export const noRepository: FakeCheckout = { isRepo: false, refName: null };

const fakeRefs = (checkout: FakeCheckout, workspaceRoot: string) => {
  const worktrees = checkout.worktrees ?? [];
  const names = [
    ...new Set([
      ...(checkout.refName === null ? [] : [checkout.refName]),
      ...(checkout.localBranchNames ?? []),
      ...worktrees.map((worktree) => worktree.branch),
    ]),
  ];
  return names.map((name) => ({
    name,
    current: name === checkout.refName,
    isDefault: false,
    worktreePath:
      worktrees.find((worktree) => worktree.branch === name)?.path ??
      (name === checkout.refName ? workspaceRoot : null),
  }));
};

/**
 * The workspace service over fake git, a recording ThreadLaunch, and receipts for the command ids
 * `accepted` reports. ThreadManagementService still comes from the test, so a shared brief lands
 * in the same dispatch log as the test's other commands.
 */
export const fakeSpawnWorkspaceLayer = (options: {
  readonly checkout: FakeCheckout;
  /**
   * When given, git reads this instead, and refs are served like upstream's cache: the snapshot
   * taken at the last `refresh` (or the first read) until the next one.
   */
  readonly liveCheckout?: Ref.Ref<FakeCheckout>;
  readonly workspaceRoot?: string;
  readonly launches?: Ref.Ref<ReadonlyArray<ThreadLaunchInput>>;
  readonly launch?: (input: ThreadLaunchInput) => Effect.Effect<void>;
  readonly accepted?: Effect.Effect<ReadonlyArray<CommandId>>;
}) => {
  let cachedCheckout: FakeCheckout | undefined;
  return layerFromReceiptStore.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService)({
          getById: (id) =>
            Effect.succeed(
              Option.some({ id, workspaceRoot: options.workspaceRoot ?? "/repo" } as never),
            ),
        }),
        Layer.mock(GitWorkflowService)({
          listRefs: (input) =>
            Effect.gen(function* () {
              const checkout =
                options.liveCheckout === undefined
                  ? options.checkout
                  : input.refresh === true || cachedCheckout === undefined
                    ? (cachedCheckout = yield* Ref.get(options.liveCheckout))
                    : cachedCheckout;
              const refs = checkout.isRepo
                ? fakeRefs(checkout, options.workspaceRoot ?? "/repo")
                : [];
              return {
                refs,
                isRepo: checkout.isRepo,
                hasPrimaryRemote: false,
                nextCursor: null,
                totalCount: refs.length,
              };
            }),
          hasCommit: ({ refName }) =>
            Effect.succeed(!(options.checkout.missingRefs ?? []).includes(refName)),
        }),
        Layer.mock(ThreadLaunchService)({
          launch: (input) =>
            Effect.gen(function* () {
              if (options.launches) yield* Ref.update(options.launches, (all) => [...all, input]);
              if (options.launch) yield* options.launch(input);
              return {
                threadId: input.threadId as ThreadId,
                projection: {} as never,
                resumed: false,
              };
            }),
        }),
        Layer.mock(CommandReceiptStoreV2)({
          getByCommandId: (commandId) =>
            (options.accepted ?? Effect.succeed([])).pipe(
              Effect.map((accepted) =>
                accepted.includes(commandId)
                  ? Option.some({
                      commandId,
                      threadId: "thread:receipt" as ThreadId,
                      commandType: "thread.create",
                      acceptedAt: DateTime.makeUnsafe(0),
                      resultSequence: 1,
                      status: "accepted" as const,
                      error: null,
                    })
                  : Option.none(),
              ),
            ),
        }),
      ),
    ),
  );
};
