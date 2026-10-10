import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import {
  J5_PLAYBOOK_WS_METHODS,
  type PlaybookDeleteRequest,
  type PlaybookError,
  type PlaybookExportRequest,
  type PlaybookLibraryRequest,
  type PlaybookRenameRequest,
} from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import { ProjectService } from "../../project/ProjectService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { playbookError, type PlaybookStore } from "./PlaybookStore.ts";
import { resolvePlaybookWorkspaceRoot } from "./workspaceRoot.ts";

export const PLAYBOOK_RPC_SCOPES = {
  [J5_PLAYBOOK_WS_METHODS.subscribeChanges]: AuthOrchestrationReadScope,
  [J5_PLAYBOOK_WS_METHODS.exportPlaybook]: AuthOrchestrationReadScope,
  [J5_PLAYBOOK_WS_METHODS.deletePlaybook]: AuthOrchestrationOperateScope,
  [J5_PLAYBOOK_WS_METHODS.renamePlaybook]: AuthOrchestrationOperateScope,
} as const;

/**
 * Share the server's store revision through the authenticated WebSocket connection, and export,
 * delete and rename definitions in the workspace a request names.
 */
export const makePlaybookRpcHandlers = Effect.fn("makePlaybookRpcHandlers")(function* (options: {
  readonly store: Pick<
    PlaybookStore["Service"],
    "changes" | "exportDefinition" | "removeDefinition" | "renameDefinition"
  >;
}) {
  const projects = yield* ProjectService;
  const threads = yield* ThreadManagementService;
  const { store } = options;
  /** Run a store call in the project's root or the thread's worktree, whichever the request names. */
  const inWorkspace = <A>(
    input: PlaybookLibraryRequest,
    run: (workspaceRoot: string) => Effect.Effect<A, PlaybookError>,
  ) =>
    resolvePlaybookWorkspaceRoot(projects, threads, input).pipe(
      Effect.mapError(() => playbookError("operation_failed", "Could not resolve the workspace.")),
      Effect.flatMap((root) =>
        root === null
          ? Effect.fail(
              playbookError(
                "workspace_not_found",
                "This project or thread workspace is no longer available.",
              ),
            )
          : run(root),
      ),
    );
  return {
    [J5_PLAYBOOK_WS_METHODS.subscribeChanges]: () => store.changes,
    [J5_PLAYBOOK_WS_METHODS.exportPlaybook]: (input: PlaybookExportRequest) =>
      inWorkspace(input, (root) => store.exportDefinition(root, input.name)),
    [J5_PLAYBOOK_WS_METHODS.deletePlaybook]: (input: PlaybookDeleteRequest) =>
      inWorkspace(input, (root) => store.removeDefinition(root, input.name)),
    [J5_PLAYBOOK_WS_METHODS.renamePlaybook]: (input: PlaybookRenameRequest) =>
      inWorkspace(input, (root) => store.renameDefinition(root, input.name, input.title)),
  };
});
