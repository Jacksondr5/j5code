import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const artifactEnvironment = {
  changes: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:artifacts:changes",
    tag: WS_METHODS.subscribeArtifactChanges,
    idleTtlMs: 0,
  }),
};
