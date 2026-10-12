import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  J5_SHARING_WS_METHODS,
  type SharingConnectionKind,
  type SharingThreadLevel,
} from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { request } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "../state/runtime.ts";

/**
 * What a shared server lets this connection do with a thread
 * (docs/j5/product/features/shared-server.md, AC12 and AC13). A member's connection is held to
 * nothing here. A guest's may write to a thread only where its level is Collaborate, so one
 * guest can read one thread and write to another on the same server. While the server has not
 * yet said which kind the connection is (`null`), nothing is withheld.
 */
export const sharingAllowsOperate = (input: {
  readonly connection: SharingConnectionKind | null;
  readonly level: SharingThreadLevel | null;
}): boolean => input.connection !== "guest" || input.level === "collaborate";

// One answer per connection: a session's kind is fixed when it is paired and never changes.
const connectionKinds = new WeakMap<RpcSession, Effect.Effect<SharingConnectionKind>>();

/**
 * Whether the environment's connection is a member's or a guest's, asked once per connection.
 * A server that cannot answer, such as one from before sharing, has no guests.
 */
export const sharingConnectionKind = Effect.gen(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  const session = yield* SubscriptionRef.get(supervisor.session);
  if (Option.isNone(session)) return "member" as const;
  const known = connectionKinds.get(session.value);
  if (known !== undefined) return yield* known;
  const asked = yield* Effect.cached(
    request(J5_SHARING_WS_METHODS.getConnectionAccess, {}).pipe(
      Effect.map((access) => access.kind),
      Effect.catchCause(() => Effect.succeed("member" as const)),
      Effect.provideService(EnvironmentSupervisor, supervisor),
    ),
  );
  connectionKinds.set(session.value, asked);
  return yield* asked;
});

const threadKey = (environmentId: EnvironmentId, threadId: ThreadId | null) =>
  JSON.stringify([environmentId, threadId]);

/** Environment-scoped atoms for what a shared server grants this connection; web and mobile each build one. */
export function createSharingEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const connectionAccess = createEnvironmentQueryAtomFamily(runtime, {
    label: "j5:sharing:connection",
    staleTimeMs: Number.MAX_SAFE_INTEGER,
    execute: (_input: Record<string, never>) => sharingConnectionKind,
  });
  // Only a guest's client opens this; the server sends the level again when a grant changes it.
  const threadAccess = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "j5:sharing:thread",
    tag: J5_SHARING_WS_METHODS.subscribeThreadAccess,
  });

  /** `null` until the server has answered for this connection. */
  const connectionKind = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): SharingConnectionKind | null =>
      Option.getOrNull(AsyncResult.value(get(connectionAccess({ environmentId, input: {} })))),
    ).pipe(Atom.withLabel(`j5:sharing:connection-kind:${environmentId}`)),
  );

  const threadOperable = Atom.family((key: string) => {
    const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId | null];
    return Atom.make((get) => {
      const connection = get(connectionKind(environmentId));
      if (connection !== "guest") return sharingAllowsOperate({ connection, level: null });
      // A view with no thread on the server, such as a draft, is nothing a guest was granted.
      const level =
        threadId === null
          ? "none"
          : (Option.getOrNull(
              AsyncResult.value(get(threadAccess({ environmentId, input: { threadId } }))),
            )?.level ?? null);
      return sharingAllowsOperate({ connection, level });
    }).pipe(Atom.withLabel(`j5:sharing:thread-operable:${key}`));
  });

  return {
    connectionKind,
    /** Whether sharing lets this connection write to the thread; upstream's permission is separate. */
    threadOperable: (environmentId: EnvironmentId, threadId: ThreadId | null) =>
      threadOperable(threadKey(environmentId, threadId)),
  };
}
