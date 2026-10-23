import {
  isProviderAvailable,
  isAgentPersonaAuthorityPolicy,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2AgentPersonaAssignment,
  type ProviderInstanceId,
  type RunId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import type { AgentPersonaDefinition } from "../agents/agentPersonas.ts";
import {
  agentPersonaModelSelection,
  agentPersonaTargetUnavailableReason,
} from "../agents/agentPersonaRouting.ts";
import {
  providerCanEnforceAgentPersonaAuthority,
  translateAgentPersonaProviderPolicy,
} from "../agents/agentPersonaProviderPolicy.ts";
import { validateAgentPersonaAssignment } from "../agents/agentPersonaAssignment.ts";

export interface LimitFailure {
  readonly providerInstanceId: ProviderInstanceId;
  readonly failedAt: number;
  readonly resetAt: number | null;
}

const freshnessMs = 60_000;

export function routeAvailability(
  provider: ServerProvider,
  failures: ReadonlyArray<LimitFailure>,
  now: number,
): boolean {
  const limits = provider.usageLimits;
  const checked = limits === undefined ? NaN : Date.parse(limits.checkedAt);
  const completeAt =
    limits?.completeCheckedAt === undefined ? NaN : Date.parse(limits.completeCheckedAt);
  const fresh =
    Number.isFinite(checked) &&
    checked <= now &&
    now - completeAt <= freshnessMs &&
    completeAt <= checked &&
    !limits?.unavailable;
  const windows = limits?.windows ?? [];
  if (limits?.paidUsageEnabled || limits?.paidUsageObserved) return false;
  if (windows.some((w) => w.id === "overage" && w.usedPercent > 0)) return false;
  const failure = failures
    .filter((f) => f.providerInstanceId === provider.instanceId)
    .toSorted((a, b) => b.failedAt - a.failedAt)[0];
  const exhausted = windows.some(
    (w) => w.usedPercent >= 100 && (w.resetsAt === undefined || Date.parse(w.resetsAt) > now),
  );
  if (exhausted && (failure === undefined || checked > failure.failedAt)) return false;
  const complete =
    provider.driver === "codex"
      ? windows.some((w) => w.kind === "session") && windows.some((w) => w.kind === "weekly")
      : windows.some((w) => w.id === "five_hour") && windows.some((w) => w.id === "seven_day");
  const positive = fresh && complete && windows.every((w) => w.usedPercent < 100);
  if (failure === undefined) return true;
  if (positive && completeAt > failure.failedAt) return true;
  if (failure.resetAt === null || failure.resetAt <= failure.failedAt || failure.resetAt > now)
    return false;
  // A later exhausted snapshot overrides the reset supplied by the failure.
  return !windows.some(
    (w) =>
      checked > failure.failedAt &&
      w.usedPercent >= 100 &&
      (w.resetsAt === undefined || Date.parse(w.resetsAt) > now),
  );
}

export type FailoverDecision =
  | {
      readonly phase: "switch" | "continue";
      readonly selection: ModelSelection;
      readonly assignment?: OrchestrationV2AgentPersonaAssignment;
    }
  | {
      readonly phase: "suspended";
      readonly reason: "no-eligible-route" | "hop-limit" | "persona-route-restricted";
    };

export function limitFailoverDecision(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly failedRunId: RunId;
  readonly failedProvider: ProviderInstanceId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly failures: ReadonlyArray<LimitFailure>;
  readonly settings: ServerSettings["usageLimitFailover"];
  readonly now: number;
  readonly definition?: AgentPersonaDefinition;
}): FailoverDecision {
  const { thread, settings, definition } = input;
  const assignment = thread.agentPersonaAssignment;
  const eligible = (selection: ModelSelection, targetAssignment = assignment) => {
    const provider = input.providers.find((p) => p.instanceId === selection.instanceId);
    if (
      !provider ||
      !["codex", "claudeAgent"].includes(provider.driver) ||
      !isProviderAvailable(provider) ||
      (thread.interactionMode !== "default" && provider.showInteractionModeToggle !== true) ||
      !provider.enabled ||
      !provider.installed ||
      provider.auth.status !== "authenticated" ||
      !settings.subscriptionOnlyInstances.includes(provider.instanceId) ||
      !provider.models.some((m) => m.slug === selection.model) ||
      !routeAvailability(provider, input.failures, input.now)
    )
      return false;
    if (targetAssignment && !isAgentPersonaAuthorityPolicy(targetAssignment.authorityPolicy))
      return false;
    const mode =
      targetAssignment?.runtimeModeOverride ??
      (targetAssignment === undefined
        ? thread.runtimeMode
        : translateAgentPersonaProviderPolicy(
            isAgentPersonaAuthorityPolicy(targetAssignment.authorityPolicy)
              ? targetAssignment.authorityPolicy
              : "read-only",
            provider.driver,
          ).runtimeMode);
    if (!provider.supportedRuntimeModes?.includes(mode)) return false;
    if (
      targetAssignment &&
      (targetAssignment.resolvedDriver !== provider.driver ||
        (targetAssignment.runtimeModeOverride === undefined &&
          !providerCanEnforceAgentPersonaAuthority(
            provider.driver,
            targetAssignment.authorityPolicy,
          )))
    )
      return false;
    const model = provider.models.find((m) => m.slug === selection.model)!;
    return (selection.options ?? []).every((option) =>
      model.capabilities?.optionDescriptors?.some(
        (descriptor) =>
          descriptor.id === option.id &&
          (descriptor.type === "boolean"
            ? typeof option.value === "boolean"
            : descriptor.options.some((choice) => choice.id === option.value)),
      ),
    );
  };
  if (eligible(thread.modelSelection))
    return { phase: "continue", selection: thread.modelSelection };
  // Once switched, wait for this target. A second switch requires a new real failure.
  if (thread.providerInstanceId !== input.failedProvider)
    return { phase: "suspended", reason: "no-eligible-route" };
  if ((thread.usageLimitFailoverHops ?? 0) >= settings.maxHops)
    return { phase: "suspended", reason: "hop-limit" };
  if (assignment) {
    if (
      !definition ||
      assignment.resolvedRoute === "override" ||
      assignment.authorityPolicy === "critic-fix" ||
      validateAgentPersonaAssignment(assignment, definition) !== undefined
    )
      return { phase: "suspended", reason: "persona-route-restricted" };
    const route: "primary" | "fallback" =
      assignment.resolvedRoute === "primary" ? "fallback" : "primary";
    const target = definition.modelRoute[route === "primary" ? 0 : 1];
    for (const provider of input.providers) {
      if (
        provider.driver !== target.driver ||
        provider.instanceId === input.failedProvider ||
        agentPersonaTargetUnavailableReason(provider, target) !== undefined
      )
        continue;
      const selection = agentPersonaModelSelection(provider, target);
      const nextAssignment = {
        ...assignment,
        resolvedRoute: route,
        resolvedDriver: provider.driver,
        resolvedModelSelection: selection,
      };
      if (
        validateAgentPersonaAssignment(nextAssignment, definition) === undefined &&
        eligible(selection, nextAssignment)
      )
        return { phase: "switch", selection, assignment: nextAssignment };
    }
    return { phase: "suspended", reason: "no-eligible-route" };
  }
  for (const selection of settings.routes) {
    if (selection.instanceId !== input.failedProvider && eligible(selection))
      return { phase: "switch", selection };
  }
  return { phase: "suspended", reason: "no-eligible-route" };
}
