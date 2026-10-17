import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import {
  J5_PLAYBOOK_WS_METHODS,
  type PlaybookDeleteRequest,
  type PlaybookError,
  type PlaybookSaveRequest,
  type PlaybookFoldersInput,
  type PlaybookExportRequest,
  type PlaybookLibraryRequest,
  type PlaybookRenameRequest,
  type PlaybookRunsRequest,
  type ThreadPlaybooksRequest,
} from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import { playbookError, type PlaybookStore } from "./PlaybookStore.ts";

export const PLAYBOOK_RPC_SCOPES = {
  [J5_PLAYBOOK_WS_METHODS.savePlaybook]: AuthOrchestrationOperateScope,
  [J5_PLAYBOOK_WS_METHODS.setFolders]: AuthOrchestrationOperateScope,
  [J5_PLAYBOOK_WS_METHODS.readSources]: AuthOrchestrationReadScope,
  [J5_PLAYBOOK_WS_METHODS.subscribeChanges]: AuthOrchestrationReadScope,
  [J5_PLAYBOOK_WS_METHODS.readLibrary]: AuthOrchestrationReadScope,
  [J5_PLAYBOOK_WS_METHODS.listThreadRuns]: AuthOrchestrationReadScope,
  [J5_PLAYBOOK_WS_METHODS.listRuns]: AuthOrchestrationReadScope,
  [J5_PLAYBOOK_WS_METHODS.exportPlaybook]: AuthOrchestrationReadScope,
  [J5_PLAYBOOK_WS_METHODS.deletePlaybook]: AuthOrchestrationOperateScope,
  [J5_PLAYBOOK_WS_METHODS.renamePlaybook]: AuthOrchestrationOperateScope,
} as const;

const failedSave = (error: PlaybookError) =>
  error.code === "operation_failed"
    ? failed("The playbook library operation failed.")(error)
    : Effect.fail(error);

const failed = (message: string) => (cause: unknown) =>
  Effect.logError(message, { cause }).pipe(
    Effect.andThen(Effect.fail(playbookError("operation_failed", message))),
  );

/**
 * Share the server's store revision through the authenticated WebSocket connection; read runs;
 * and manage definitions in this environment's library.
 */
export const makePlaybookRpcHandlers = (options: {
  readonly store: Pick<
    PlaybookStore["Service"],
    | "changes"
    | "listForThread"
    | "listAll"
    | "saveDefinition"
    | "setFolders"
    | "sources"
    | "discover"
    | "exportDefinition"
    | "removeDefinition"
    | "renameDefinition"
  >;
}) => {
  const { store } = options;
  return Effect.succeed({
    [J5_PLAYBOOK_WS_METHODS.savePlaybook]: (input: PlaybookSaveRequest) =>
      store.saveDefinition(input).pipe(Effect.catch(failedSave)),
    [J5_PLAYBOOK_WS_METHODS.setFolders]: (input: PlaybookFoldersInput) =>
      store.setFolders(input).pipe(Effect.catch(failedSave)),
    [J5_PLAYBOOK_WS_METHODS.readSources]: () => store.sources().pipe(Effect.catch(failedSave)),
    [J5_PLAYBOOK_WS_METHODS.subscribeChanges]: () => store.changes,
    [J5_PLAYBOOK_WS_METHODS.readLibrary]: (_input: PlaybookLibraryRequest) =>
      store.discover().pipe(Effect.catch(failedSave)),
    [J5_PLAYBOOK_WS_METHODS.listThreadRuns]: (input: typeof ThreadPlaybooksRequest.Type) =>
      store
        .listForThread(input.threadId)
        .pipe(Effect.catch(failed("Reading the thread's playbook runs failed."))),
    [J5_PLAYBOOK_WS_METHODS.listRuns]: (input: PlaybookRunsRequest) =>
      store.listAll(input).pipe(Effect.catch(failed("Reading playbook runs failed."))),
    [J5_PLAYBOOK_WS_METHODS.exportPlaybook]: (input: PlaybookExportRequest) =>
      store.exportDefinition(input.name, input.source).pipe(Effect.catch(failedSave)),
    [J5_PLAYBOOK_WS_METHODS.deletePlaybook]: (input: PlaybookDeleteRequest) =>
      store.removeDefinition(input.name, input.source).pipe(Effect.catch(failedSave)),
    [J5_PLAYBOOK_WS_METHODS.renamePlaybook]: (input: PlaybookRenameRequest) =>
      store.renameDefinition(input.name, input.title, input.source).pipe(Effect.catch(failedSave)),
  });
};
