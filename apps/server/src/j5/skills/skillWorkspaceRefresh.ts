import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import type { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";

const MAX_WORKSPACE_SNAPSHOTS_PER_PROVIDER = 16;

export function upsertProviderWorkspaceSnapshot(
  provider: ServerProvider,
  cwd: string,
  scopedSnapshot: ServerProvider,
): ServerProvider {
  const previous = provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd);
  const workspaceSnapshot =
    scopedSnapshot.status === "error"
      ? {
          cwd,
          checkedAt: previous?.checkedAt ?? scopedSnapshot.checkedAt,
          slashCommands: previous?.slashCommands ?? [],
          skills: previous?.skills ?? [],
          refreshError: scopedSnapshot.message || "Workspace discovery failed.",
        }
      : ({
          cwd,
          checkedAt: scopedSnapshot.checkedAt,
          slashCommands: scopedSnapshot.slashCommands,
          skills: scopedSnapshot.skills,
        } satisfies NonNullable<ServerProvider["workspaceSnapshots"]>[number]);
  return {
    ...provider,
    workspaceSnapshots: [
      ...(provider.workspaceSnapshots ?? []).filter((snapshot) => snapshot.cwd !== cwd),
      workspaceSnapshot,
    ].slice(-MAX_WORKSPACE_SNAPSHOTS_PER_PROVIDER),
  };
}

export const makeSkillWorkspaceRefresh = Effect.fn("j5.skills.makeWorkspaceRefresh")(function* ({
  instanceRegistry,
  providersRef,
  changesPubSub,
}: {
  readonly instanceRegistry: ProviderInstanceRegistry["Service"];
  readonly providersRef: Ref.Ref<ReadonlyArray<ServerProvider>>;
  readonly changesPubSub: PubSub.PubSub<ReadonlyArray<ServerProvider>>;
}) {
  const workspaceRefreshesRef = yield* Ref.make<
    ReadonlyMap<ProviderInstance, ReadonlyMap<string, symbol>>
  >(new Map());
  const refreshWorkspaceSnapshot = Effect.fn("refreshWorkspaceSnapshot")(function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly cwd: string;
    readonly force?: boolean;
  }) {
    const providers = yield* Ref.get(providersRef);
    const provider = providers.find((candidate) => candidate.instanceId === input.instanceId);
    if (
      !provider ||
      !provider.enabled ||
      (!input.force &&
        provider.workspaceSnapshots?.some((s) => s.cwd === input.cwd && !s.refreshError))
    ) {
      return providers;
    }
    const instance = yield* instanceRegistry.getInstance(input.instanceId);
    if (!instance?.snapshotForCwd) return providers;
    const request = Symbol();
    const claimed = yield* Ref.modify(workspaceRefreshesRef, (refreshes) => {
      const current = refreshes.get(instance);
      if (!input.force && current?.has(input.cwd)) return [false, refreshes] as const;
      const next = new Map(refreshes);
      next.set(instance, new Map(current).set(input.cwd, request));
      return [true, next] as const;
    });
    if (!claimed) return yield* Ref.get(providersRef);
    return yield* instance.snapshotForCwd(input.cwd).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        return Effect.succeed({
          ...provider,
          status: "error" as const,
          message: "Workspace discovery failed.",
        });
      }),
      Effect.flatMap((scopedSnapshot) =>
        instanceRegistry.getInstance(input.instanceId).pipe(
          Effect.flatMap(
            Effect.fn(function* (currentInstance) {
              const requests = yield* Ref.get(workspaceRefreshesRef);
              if (
                currentInstance !== instance ||
                requests.get(instance)?.get(input.cwd) !== request
              ) {
                return yield* Ref.get(providersRef);
              }
              return yield* Ref.modify(providersRef, (currentProviders) => {
                const nextProviders = currentProviders.map((candidate) =>
                  candidate.instanceId === input.instanceId &&
                  (input.force ||
                    !candidate.workspaceSnapshots?.some(
                      (s) => s.cwd === input.cwd && !s.refreshError,
                    ))
                    ? upsertProviderWorkspaceSnapshot(candidate, input.cwd, scopedSnapshot)
                    : candidate,
                );
                return [[currentProviders, nextProviders] as const, nextProviders];
              }).pipe(
                Effect.tap(([previousProviders, nextProviders]) =>
                  !Equal.equals(previousProviders, nextProviders)
                    ? PubSub.publish(changesPubSub, nextProviders)
                    : Effect.void,
                ),
                Effect.map(([, nextProviders]) => nextProviders),
              );
            }),
          ),
        ),
      ),
      Effect.ensuring(
        Ref.update(workspaceRefreshesRef, (refreshes) => {
          if (refreshes.get(instance)?.get(input.cwd) !== request) return refreshes;
          const next = new Map(refreshes);
          const current = new Map(next.get(instance));
          current.delete(input.cwd);
          if (current.size) next.set(instance, current);
          else next.delete(instance);
          return next;
        }),
      ),
    );
  });

  return {
    refreshWorkspaceSnapshot,
    getPendingWorkspaceCwds: (instanceId: ProviderInstanceId) =>
      instanceRegistry
        .getInstance(instanceId)
        .pipe(
          Effect.flatMap((instance) =>
            Ref.get(workspaceRefreshesRef).pipe(
              Effect.map((pending) => (instance ? [...(pending.get(instance)?.keys() ?? [])] : [])),
            ),
          ),
        ),
  };
});
