import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type { ProviderRegistryShape } from "../../provider/Services/ProviderRegistry.ts";

/** Keep a failed inventory probe separate from the provider's ability to run turns. */
export const recordSkillDiscoveryFailure = Effect.fn("j5.skills.recordDiscoveryFailure")(function* (
  instanceId: ProviderInstanceId,
  cause: Cause.Cause<unknown>,
  getProviders: ProviderRegistryShape["getProviders"],
  syncProvider: (provider: ServerProvider) => Effect.Effect<ReadonlyArray<ServerProvider>>,
) {
  if (Cause.hasInterruptsOnly(cause)) return yield* Effect.interrupt;
  const previous = (yield* getProviders).find((provider) => provider.instanceId === instanceId);
  if (previous)
    yield* syncProvider({ ...previous, skillDiscoveryError: "Provider discovery failed." });
  yield* Effect.logWarning("Provider discovery failed; retaining cached provider health", {
    cause,
  });
  return yield* getProviders;
});

/** Explicit refresh and mutations replace cached and pending workspace discovery. */
export const refreshSkillProviders = Effect.fn("j5.skills.refreshProviders")(function* (
  registry: ProviderRegistryShape,
  instanceIds?: ReadonlyArray<ProviderInstanceId>,
  additionalCwds: ReadonlyArray<string> = [],
) {
  const snapshots = yield* registry.getProviders;
  yield* Effect.forEach(
    snapshots.filter(
      (provider) => provider.enabled && (!instanceIds || instanceIds.includes(provider.instanceId)),
    ),
    (provider) =>
      Effect.gen(function* () {
        const pending = yield* registry.getPendingWorkspaceCwds(provider.instanceId);
        const cwds = new Set([
          ...pending,
          ...(provider.workspaceSnapshots ?? []).map((s) => s.cwd),
          ...additionalCwds,
        ]);
        yield* registry.refreshInstance(provider.instanceId);
        yield* Effect.forEach(
          cwds,
          (cwd) =>
            registry.refreshWorkspaceSnapshot({
              instanceId: provider.instanceId,
              cwd,
              force: true,
            }),
          { concurrency: 2, discard: true },
        );
      }),
    { concurrency: 2, discard: true },
  );
  return yield* registry.getProviders;
});
