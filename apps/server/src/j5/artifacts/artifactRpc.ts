import {
  ArtifactWatchError,
  AuthOrchestrationReadScope,
  J5_ARTIFACT_WS_METHODS,
  type ArtifactWatchInput,
  type EnvironmentAuthorizationError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type * as ProjectService from "../../project/ProjectService.ts";
import type { ArtifactWorkspace } from "./ArtifactWorkspace.ts";

const METHODS = J5_ARTIFACT_WS_METHODS;

/** Spread into upstream's scope table beside the persona scopes; every J5 RPC names its scope here. */
export const ARTIFACT_RPC_SCOPES = {
  [METHODS.subscribeArtifactChanges]: AuthOrchestrationReadScope,
} as const;

/**
 * The artifact change stream: a first event on subscribe so the client knows the watch is live,
 * then one event per debounced filesystem change with a monotonic revision. The handler is built
 * here and spread into upstream's WebSocket handler map, the same way the persona RPCs are.
 */
export function makeArtifactRpcHandlers(input: {
  readonly projects: Pick<ProjectService.ProjectService["Service"], "getById">;
  readonly artifacts: Pick<ArtifactWorkspace["Service"], "watch">;
  /** Upstream's authorize-then-instrument wrapper for a stream-producing effect (ws.ts). */
  readonly observeStream: <A, StreamError, StreamContext, EffectError, EffectContext>(
    method: string,
    effect: Effect.Effect<Stream.Stream<A, StreamError, StreamContext>, EffectError, EffectContext>,
    traceAttributes?: Readonly<Record<string, unknown>>,
  ) => Stream.Stream<
    A,
    StreamError | EffectError | EnvironmentAuthorizationError,
    StreamContext | EffectContext
  >;
}) {
  return {
    [METHODS.subscribeArtifactChanges]: (request: ArtifactWatchInput) =>
      input.observeStream(
        METHODS.subscribeArtifactChanges,
        input.projects.getById(request.projectId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new ArtifactWatchError({
                    projectId: request.projectId,
                    detail: `Project ${request.projectId} is not available.`,
                  }),
                ),
              onSome: () =>
                Effect.succeed(
                  Stream.merge(
                    Stream.make({ projectId: request.projectId, revision: 0 }),
                    input.artifacts.watch(request.projectId).pipe(
                      Stream.mapError(
                        (cause) =>
                          new ArtifactWatchError({
                            projectId: request.projectId,
                            detail: cause.message,
                          }),
                      ),
                      Stream.mapAccum(
                        () => 0,
                        (revision) => {
                          const nextRevision = revision + 1;
                          return [
                            nextRevision,
                            [{ projectId: request.projectId, revision: nextRevision }],
                          ] as const;
                        },
                      ),
                    ),
                  ),
                ),
            }),
          ),
          Effect.mapError(
            (cause) =>
              new ArtifactWatchError({ projectId: request.projectId, detail: cause.message }),
          ),
        ),
        { "rpc.aggregate": "artifacts" },
      ),
  };
}
