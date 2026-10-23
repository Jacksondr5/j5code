import {
  resolveProjectProviderInstanceEnabled,
  type OrchestrationV2ThreadProjection,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerPreferences from "../../serverSettings.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import {
  latestExecutedRun,
  latestRootProviderFailure,
} from "@t3tools/shared/orchestrationV2ThreadError";
import { makeAgentPersonaLibrary } from "../agents/agentPersonaLibrary.ts";
import { limitFailoverDecision } from "./usageLimitFailover.ts";

export const makeFailoverPlanner = Effect.gen(function* () {
  const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const library = yield* makeAgentPersonaLibrary;
  const preferences = yield* ServerPreferences.ServerSettingsService;
  return Effect.fn("j5.planUsageLimitFailover")(function* (
    projection: OrchestrationV2ThreadProjection,
    settings: ServerSettings["usageLimitFailover"],
    now: number,
  ) {
    const run = latestExecutedRun(projection.runs);
    const failure = latestRootProviderFailure(run ?? null, projection.turnItems);
    const thread = projection.thread;
    if (
      !settings.enabled ||
      Option.isNone(registry) ||
      run?.status !== "failed" ||
      failure?.class !== "usage_limit" ||
      thread.archivedAt !== null ||
      thread.deletedAt !== null ||
      thread.settledOverride === "settled" ||
      projection.runtimeRequests.some((r) => r.status === "pending") ||
      projection.runs.some((r) =>
        ["preparing", "starting", "running", "waiting"].includes(r.status),
      )
    )
      return null;
    const definition =
      thread.agentPersonaAssignment === undefined
        ? undefined
        : yield* library.readSnapshot(thread.agentPersonaAssignment);
    const currentSettings = yield* preferences.getSettings;
    const providers = (yield* registry.value.getProviders).filter((p) =>
      resolveProjectProviderInstanceEnabled(currentSettings, thread.projectId, p.instanceId),
    );
    const decision = limitFailoverDecision({
      thread,
      failedRunId: run.id,
      failedProvider: run.providerInstanceId,
      providers,
      failures: yield* projections.getUsageLimitFailures,
      settings,
      now,
      ...(definition === undefined ? {} : { definition }),
    });
    return { run, decision };
  });
});
