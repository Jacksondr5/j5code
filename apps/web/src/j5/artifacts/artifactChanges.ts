import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { J5_ARTIFACT_WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../../connection/runtime";

/** One live subscription per project; the Artifacts page refreshes on each revision. */
export const artifactEnvironment = {
  changes: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:artifacts:changes",
    tag: J5_ARTIFACT_WS_METHODS.subscribeArtifactChanges,
    idleTtlMs: 0,
  }),
};
