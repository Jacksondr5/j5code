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
  readonly refName: string | null;
  readonly localBranchNames?: ReadonlyArray<string>;
  /** Refs git can't resolve; every other ref exists. */
  readonly missingRefs?: ReadonlyArray<string>;
}

/** A project that is not a git repository: every default resolves to the caller's checkout. */
export const noRepository: FakeCheckout = { isRepo: false, refName: null };

/**
 * The workspace service over fake git, a recording ThreadLaunch, and receipts for the command ids
 * `accepted` reports. ThreadManagementService still comes from the test, so a shared brief lands
 * in the same dispatch log as the test's other commands.
 */
export const fakeSpawnWorkspaceLayer = (options: {
  readonly checkout: FakeCheckout;
  readonly workspaceRoot?: string;
  readonly launches?: Ref.Ref<ReadonlyArray<ThreadLaunchInput>>;
  readonly launch?: (input: ThreadLaunchInput) => Effect.Effect<void>;
  readonly accepted?: Effect.Effect<ReadonlyArray<CommandId>>;
}) =>
  layerFromReceiptStore.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService)({
          getById: (id) =>
            Effect.succeed(
              Option.some({ id, workspaceRoot: options.workspaceRoot ?? "/repo" } as never),
            ),
        }),
        Layer.mock(GitWorkflowService)({
          localStatus: () =>
            Effect.succeed({
              isRepo: options.checkout.isRepo,
              refName: options.checkout.refName,
            } as never),
          listLocalBranchNames: () =>
            Effect.succeed([...(options.checkout.localBranchNames ?? [])]),
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
