import * as Schema from "effect/Schema";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

import { ArtifactChangeEvent, ArtifactWatchError, ArtifactWatchInput } from "../artifacts.ts";
import { EnvironmentAuthorizationError } from "../auth.ts";
import { ProjectId } from "../baseSchemas.ts";

export const ARTIFACT_TRASH_PATH = "/api/j5/artifacts/trash";

export const ArtifactTrashRequest = Schema.Struct({
  projectId: ProjectId,
  path: Schema.String,
});
export type ArtifactTrashRequest = typeof ArtifactTrashRequest.Type;

export const ArtifactTrashResponse = Schema.Struct({
  trashed: Schema.Literal(true),
});
export type ArtifactTrashResponse = typeof ArtifactTrashResponse.Type;

/**
 * The J5 artifact WebSocket surface: one stream that tells a client a project's artifacts
 * directory changed. Lives in its own group, merged into the upstream group in one place, so
 * upstream's method table and RPC list stay untouched.
 */
export const J5_ARTIFACT_WS_METHODS = {
  subscribeArtifactChanges: "j5.artifacts.subscribeChanges",
} as const;

export const WsJ5SubscribeArtifactChangesRpc = Rpc.make(
  J5_ARTIFACT_WS_METHODS.subscribeArtifactChanges,
  {
    payload: ArtifactWatchInput,
    success: ArtifactChangeEvent,
    error: Schema.Union([ArtifactWatchError, EnvironmentAuthorizationError]),
    stream: true,
  },
);

export const J5ArtifactRpcGroup = RpcGroup.make(WsJ5SubscribeArtifactChangesRpc);
