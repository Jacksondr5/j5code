import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import { J5_PLAYBOOK_WS_METHODS, type PlaybookExportRequest } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import { ProjectService } from "../../project/ProjectService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { playbookError, type PlaybookStore } from "./PlaybookStore.ts";
import { resolvePlaybookWorkspaceRoot } from "./workspaceRoot.ts";

export const PLAYBOOK_RPC_SCOPES = {
  [J5_PLAYBOOK_WS_METHODS.subscribeChanges]: AuthOrchestrationReadScope,
  [J5_PLAYBOOK_WS_METHODS.exportPlaybook]: AuthOrchestrationReadScope,
} as const;

/** Share the server's store revision through the authenticated WebSocket connection and export definitions. */
export const makePlaybookRpcHandlers = Effect.fn("makePlaybookRpcHandlers")(function* (options: {
  readonly store: Pick<PlaybookStore["Service"], "changes" | "exportDefinition">;
}) {
  const projects = yield* ProjectService;
  const threads = yield* ThreadManagementService;
  const { store } = options;
  return {
    [J5_PLAYBOOK_WS_METHODS.subscribeChanges]: () => store.changes,
    [J5_PLAYBOOK_WS_METHODS.exportPlaybook]: (input: PlaybookExportRequest) =>
      resolvePlaybookWorkspaceRoot(projects, threads, input).pipe(
        Effect.mapError(() =>
          playbookError("operation_failed", "Could not resolve the workspace."),
        ),
        Effect.flatMap((root) =>
          root === null
            ? Effect.fail(
                playbookError(
                  "workspace_not_found",
                  "This project or thread workspace is no longer available.",
                ),
              )
            : store.exportDefinition(root, input.name),
        ),
      ),
  };
});
