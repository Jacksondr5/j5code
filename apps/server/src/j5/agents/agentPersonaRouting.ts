import {
  agentPersonaReasoningDescriptor,
  defaultInstanceIdForDriver,
  isProviderAvailable,
  isAgentPersonaReasoningOptionId,
  type AgentPersonaAuthorityPolicy,
  type AgentPersonaModelEntry,
  type AgentPersonaDefinitionView,
  ProviderDriverKind,
  type AgentPersonaRouteFailureCode as ContractRouteFailureCode,
  type ModelSelection,
  type OrchestrationV2AgentPersonaCatalog,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  getBuiltInAgentPersona,
  agentPersonaPolicy,
  agentPersonaAccess,
  type AgentPersonaDefinition,
  type AgentPersonaId,
} from "./agentPersonas.ts";
import { providerCanEnforceAgentPersonaAuthority } from "./agentPersonaProviderPolicy.ts";
import { crewModelSelectionProblem } from "./agentModelSelection.ts";

export function agentPersonaDefinitionView(
  definition: AgentPersonaDefinition,
  providers: ReadonlyArray<ServerProvider>,
): AgentPersonaDefinitionView {
  // A legacy summary is display-only; new definitions never expose the legacy edit metadata.
  const summary = (entry: AgentPersonaDefinition["modelRoute"][number]) => {
    if ("driver" in entry) return entry;
    const reasoning = entry.options?.find(({ id }) => isAgentPersonaReasoningOptionId(id))?.value;
    return {
      driver:
        providers.find(({ instanceId }) => instanceId === entry.instanceId)?.driver ??
        ProviderDriverKind.make("unconfigured"),
      model: entry.model,
      reasoningEffort: typeof reasoning === "string" ? reasoning : "Provider default",
    };
  };
  const [primary, secondary] = definition.modelRoute;
  const policy = agentPersonaPolicy(definition);
  return {
    id: definition.id,
    version: definition.version,
    displayName: definition.displayName,
    description: definition.description,
    instructions: definition.instructions,
    ...(definition.acceptedInput === undefined ? {} : { acceptedInput: definition.acceptedInput }),
    authority: { defaultPolicy: policy, allowedPolicies: [policy] },
    modelRoute: [summary(primary), summary(secondary ?? primary)],
    access: agentPersonaAccess(definition),
    models: definition.modelRoute,
    ...(definition.independentReviewer === true ? { independentReviewer: true } : {}),
  };
}

export type AgentPersonaRouteFailureCode = ContractRouteFailureCode;
export interface AgentPersonaRouteFailure {
  readonly code: AgentPersonaRouteFailureCode;
  readonly instanceId?: ProviderInstanceId;
}
export interface AgentPersonaRouteAttempt {
  readonly route: "primary" | "fallback";
  readonly entryIndex: number;
  readonly target: AgentPersonaModelEntry;
  readonly modelSelection?: ModelSelection;
  readonly failures: ReadonlyArray<AgentPersonaRouteFailure>;
}
export type AgentPersonaRouteResolution =
  | {
      readonly status: "available";
      readonly personaId: AgentPersonaId;
      readonly definitionVersion: number;
      readonly route: "primary" | "fallback";
      readonly entryIndex?: number;
      readonly driver: ProviderDriverKind;
      readonly modelSelection: ModelSelection;
      readonly rejectedTargets: ReadonlyArray<AgentPersonaRouteAttempt>;
      readonly entries?: ReadonlyArray<AgentPersonaRouteAttempt>;
    }
  | {
      readonly status: "unavailable";
      readonly personaId: AgentPersonaId;
      readonly definitionVersion: number;
      readonly attempts: ReadonlyArray<AgentPersonaRouteAttempt>;
    };

function unavailableAgentPersonaReason(
  resolution: Extract<AgentPersonaRouteResolution, { status: "unavailable" }>,
): "routes-unavailable" | "authority-not-enforceable" {
  return resolution.attempts.every(({ failures }) =>
    failures.some(({ code }) => code === "authority-not-enforceable"),
  )
    ? "authority-not-enforceable"
    : "routes-unavailable";
}

export function agentPersonaModelSelection(
  provider: ServerProvider,
  target: AgentPersonaModelEntry,
): ModelSelection {
  if ("instanceId" in target) return target;
  const descriptor = agentPersonaReasoningDescriptor(
    provider.models.find((model) => model.slug === target.model),
  );
  if (descriptor === undefined)
    throw new Error(
      `Model ${target.model} on ${provider.instanceId} advertises no reasoning option; check availability first.`,
    );
  return {
    instanceId: provider.instanceId,
    model: target.model,
    options: [{ id: descriptor.id, value: target.reasoningEffort }],
  };
}

export function agentPersonaEntryMatches(
  target: AgentPersonaModelEntry,
  selection: ModelSelection,
  driver: string,
): boolean {
  const optionIds = (selection.options ?? []).map(({ id }) => id);
  if (new Set(optionIds).size !== optionIds.length || target.model !== selection.model)
    return false;
  if ("instanceId" in target) {
    return (
      target.instanceId === selection.instanceId &&
      (target.options ?? []).every((option) =>
        selection.options?.some(({ id, value }) => id === option.id && value === option.value),
      )
    );
  }
  const reasoning = (selection.options ?? []).filter(({ id }) =>
    isAgentPersonaReasoningOptionId(id),
  );
  return (
    target.driver === driver &&
    reasoning.length === 1 &&
    reasoning[0]?.value === target.reasoningEffort
  );
}

export function agentPersonaTargetUnavailableReason(
  provider: ServerProvider,
  target: AgentPersonaModelEntry,
  now: number,
): AgentPersonaRouteFailureCode | undefined {
  if (!isProviderAvailable(provider)) return "provider-unavailable";
  if (!provider.enabled) return "provider-disabled";
  if (!provider.installed) return "provider-not-installed";
  if (provider.status === "error" || provider.status === "disabled") return "provider-error";
  if (provider.auth.status === "unauthenticated") return "provider-unauthenticated";
  const model = provider.models.find((candidate) => candidate.slug === target.model);
  if (model === undefined) return "model-not-advertised";
  if ("instanceId" in target) {
    if (target.instanceId !== provider.instanceId) return "provider-not-configured";
    if (crewModelSelectionProblem(target, provider) !== null) {
      const reasoning = (target.options ?? []).filter(({ id }) =>
        isAgentPersonaReasoningOptionId(id),
      );
      if (crewModelSelectionProblem({ ...target, options: reasoning }, provider) !== null)
        return "reasoning-effort-not-advertised";
      return "option-not-advertised";
    }
  } else {
    const descriptor = agentPersonaReasoningDescriptor(model);
    if (!descriptor?.options.some((option) => option.id === target.reasoningEffort))
      return "reasoning-effort-not-advertised";
  }
  const limits = provider.usageLimits;
  // No-reset spend telemetry does not establish that a provider cannot start work.
  if (
    limits?.unavailable?.reason !== "unsupported" &&
    limits?.windows.some(
      (window) =>
        ((provider.driver === "claudeAgent" && ["five_hour", "seven_day"].includes(window.id)) ||
          (provider.driver === "codex" &&
            ["primary", "secondary", "individual"].includes(window.id))) &&
        window.usedPercent >= 100 &&
        window.resetsAt !== undefined &&
        Date.parse(window.resetsAt) > now,
    )
  )
    return "usage-limit";
  return undefined;
}

function candidatesForTarget(
  providers: ReadonlyArray<ServerProvider>,
  target: AgentPersonaModelEntry,
) {
  if ("instanceId" in target)
    return providers.filter((provider) => provider.instanceId === target.instanceId);
  return providers
    .filter((provider) => provider.driver === target.driver)
    .map((provider, index) => ({
      provider,
      index,
      isDefault: provider.instanceId === defaultInstanceIdForDriver(provider.driver),
    }))
    .sort(
      (left, right) => Number(right.isDefault) - Number(left.isDefault) || left.index - right.index,
    )
    .map(({ provider }) => provider);
}

/** A model id without a provider prefix, so `anthropic/claude-opus-5-5` matches `claude-opus-5-5`. */
export const sameModelKey = (model: string) => model.slice(model.lastIndexOf("/") + 1);

/** Whether an agent may pick this resolved selection; a person's pick passes none. */
export type AgentPersonaEntryEligibility = (
  selection: ModelSelection,
  provider: ServerProvider,
) => boolean;

export function resolveAgentPersonaRoute(input: {
  readonly personaId: AgentPersonaId;
  readonly definition?: AgentPersonaDefinition;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly authorityPolicy?: AgentPersonaAuthorityPolicy;
  readonly now: number;
  readonly eligible?: AgentPersonaEntryEligibility | undefined;
  /** Model ids to use only when no other entry can run: an independent reviewer's authors'. */
  readonly avoidModels?: ReadonlySet<string> | undefined;
}): AgentPersonaRouteResolution {
  const definition = input.definition ?? getBuiltInAgentPersona(input.personaId);
  const authority = input.authorityPolicy ?? agentPersonaPolicy(definition);
  const now = input.now;
  const entries = definition.modelRoute.map((target, entryIndex): AgentPersonaRouteAttempt => {
    const route = entryIndex === 0 ? "primary" : "fallback";
    const candidates = candidatesForTarget(input.providers, target);
    const failures: AgentPersonaRouteFailure[] = [];
    if (candidates.length === 0) {
      if ("driver" in target && !providerCanEnforceAgentPersonaAuthority(target.driver, authority))
        failures.push({ code: "authority-not-enforceable" });
      failures.push({ code: "provider-not-configured" });
    }
    for (const provider of candidates) {
      const reason = !providerCanEnforceAgentPersonaAuthority(provider.driver, authority)
        ? "authority-not-enforceable"
        : agentPersonaTargetUnavailableReason(provider, target, now);
      if (reason !== undefined) {
        failures.push({ code: reason, instanceId: provider.instanceId });
        continue;
      }
      const modelSelection = agentPersonaModelSelection(provider, target);
      if (input.eligible !== undefined && !input.eligible(modelSelection, provider)) {
        failures.push({ code: "model-not-eligible", instanceId: provider.instanceId });
        continue;
      }
      return { route, entryIndex, target, modelSelection, failures: [] };
    }
    return { route, entryIndex, target, failures };
  });
  const runnable = entries.filter((entry) => entry.modelSelection !== undefined);
  const avoid =
    input.avoidModels === undefined ? undefined : new Set([...input.avoidModels].map(sameModelKey));
  const chosen =
    (avoid === undefined
      ? undefined
      : runnable.find((entry) => !avoid.has(sameModelKey(entry.modelSelection!.model)))) ??
    runnable[0];
  if (chosen?.modelSelection !== undefined) {
    const provider = input.providers.find(
      ({ instanceId }) => instanceId === chosen.modelSelection!.instanceId,
    )!;
    return {
      status: "available",
      personaId: definition.id,
      definitionVersion: definition.version,
      route: chosen.route,
      entryIndex: chosen.entryIndex,
      driver: provider.driver,
      modelSelection: chosen.modelSelection,
      rejectedTargets: entries
        .slice(0, chosen.entryIndex)
        .filter((entry) => entry.modelSelection === undefined),
      entries,
    };
  }
  return {
    status: "unavailable",
    personaId: definition.id,
    definitionVersion: definition.version,
    attempts: entries,
  };
}

export function buildAgentPersonaCatalog(
  providers: ReadonlyArray<ServerProvider>,
  definitions: ReadonlyArray<AgentPersonaDefinition>,
  now: number,
): OrchestrationV2AgentPersonaCatalog {
  return {
    personas: definitions.map((definition) => {
      const resolution = resolveAgentPersonaRoute({
        personaId: definition.id,
        definition,
        providers,
        now,
      });
      const entries =
        resolution.status === "available" ? (resolution.entries ?? []) : resolution.attempts;
      return {
        personaId: definition.id,
        definitionVersion: definition.version,
        displayName: definition.displayName,
        description: definition.description,
        ...(definition.acceptedInput === undefined
          ? {}
          : { acceptedInput: definition.acceptedInput }),
        access: agentPersonaAccess(definition),
        models: definition.modelRoute,
        ...(definition.independentReviewer === true ? { independentReviewer: true } : {}),
        defaultAuthorityPolicy: agentPersonaPolicy(definition),
        allowedAuthorityPolicies: [agentPersonaPolicy(definition)],
        modelEntries: entries.map((entry) => ({
          index: entry.entryIndex,
          target: entry.target,
          ...(entry.modelSelection === undefined ? {} : { modelSelection: entry.modelSelection }),
          failures: [...new Set(entry.failures.map(({ code }) => code))],
        })),
        availability:
          resolution.status === "available"
            ? {
                status: "available" as const,
                resolvedRoute: resolution.route,
                resolvedEntryIndex: resolution.entryIndex,
                resolvedDriver: resolution.driver,
                resolvedModelSelection: resolution.modelSelection,
              }
            : {
                status: "unavailable" as const,
                reason: unavailableAgentPersonaReason(resolution),
              },
      };
    }),
  };
}
