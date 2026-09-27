import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import { J5_PLAYBOOK_WS_METHODS } from "@t3tools/contracts/j5";
import type { ObserveRpcStream } from "../agents/agentPersonaRpc.ts";
import type { PlaybookStore } from "./PlaybookStore.ts";

export const PLAYBOOK_RPC_SCOPES = {
  [J5_PLAYBOOK_WS_METHODS.subscribeChanges]: AuthOrchestrationReadScope,
} as const;

/** Share the server's store revision through the authenticated WebSocket connection. */
export function makePlaybookRpcHandlers(
  store: Pick<PlaybookStore["Service"], "changes">,
  observeStream: ObserveRpcStream,
) {
  return {
    [J5_PLAYBOOK_WS_METHODS.subscribeChanges]: () =>
      observeStream(J5_PLAYBOOK_WS_METHODS.subscribeChanges, store.changes),
  };
}
