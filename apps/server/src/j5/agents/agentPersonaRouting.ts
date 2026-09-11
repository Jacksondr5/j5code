import {
  defaultInstanceIdForDriver,
  isProviderAvailable,
  ProviderDriverKind,
  type AgentPersonaAuthorityPolicy,
  type ModelSelection,
  type OrchestrationV2AgentPersonaCatalog,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

import {
  getBuiltInAgentPersona,
  listBuiltInAgentPersonas,
  type AgentModelTarget,
  type AgentPersonaId,
} from "./agentPersonas.ts";
import { providerCanEnforceAgentPersonaAuthority } from "./agentPersonaProviderPolicy.ts";

export type AgentPersonaRouteFailureCode =
  | "provider-not-configured"
  | "provider-unavailable"
  | "provider-disabled"
  | "provider-not-installed"
  | "provider-error"
  | "provider-unauthenticated"
  | "model-not-advertised"
  | "reasoning-effort-not-advertised"
  | "authority-not-enforceable";

export interface AgentPersonaRouteFailure {
  readonly code: AgentPersonaRouteFailureCode;
  readonly instanceId?: ProviderInstanceId;
}

export interface AgentPersonaRouteAttempt {
  readonly route: "primary" | "fallback";
  readonly target: AgentModelTarget;
  readonly failures: ReadonlyArray<AgentPersonaRouteFailure>;
}

export type AgentPersonaRouteResolution =
  | {
      readonly status: "available";
      readonly personaId: AgentPersonaId;
      readonly definitionVersion: 1;
      readonly route: "primary" | "fallback";
      readonly driver: AgentModelTarget["driver"];
      readonly modelSelection: ModelSelection;
      readonly rejectedTargets: ReadonlyArray<AgentPersonaRouteAttempt>;
    }
  | {
      readonly status: "unavailable";
      readonly personaId: AgentPersonaId;
      readonly definitionVersion: 1;
      readonly attempts: ReadonlyArray<AgentPersonaRouteAttempt>;
    };

export function unavailableAgentPersonaReason(
  resolution: Extract<AgentPersonaRouteResolution, { status: "unavailable" }>,
): "routes-unavailable" | "authority-not-enforceable" {
  return resolution.attempts.every(
    ({ failures }) =>
      failures.length > 0 && failures.every(({ code }) => code === "authority-not-enforceable"),
  )
    ? "authority-not-enforceable"
    : "routes-unavailable";
}

function unavailableReason(
  provider: ServerProvider,
  target: AgentModelTarget,
): AgentPersonaRouteFailureCode | undefined {
  if (!isProviderAvailable(provider)) return "provider-unavailable";
  if (!provider.enabled) return "provider-disabled";
  if (!provider.installed) return "provider-not-installed";
  if (provider.status === "error" || provider.status === "disabled") return "provider-error";
  if (provider.auth.status === "unauthenticated") return "provider-unauthenticated";
  const model = provider.models.find((candidate) => candidate.slug === target.model);
  if (model === undefined) return "model-not-advertised";

  const optionId = target.driver === "codex" ? "reasoningEffort" : "effort";
  const descriptor = model.capabilities?.optionDescriptors?.find(
    (candidate) => candidate.id === optionId,
  );
  if (
    descriptor?.type !== "select" ||
    !descriptor.options.some((option) => option.id === target.reasoningEffort)
  ) {
    return "reasoning-effort-not-advertised";
  }
  return undefined;
}

function candidatesForTarget(
  providers: ReadonlyArray<ServerProvider>,
  target: AgentModelTarget,
): ReadonlyArray<ServerProvider> {
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

export function resolveBuiltInAgentPersonaRoute(input: {
  readonly personaId: AgentPersonaId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly authorityPolicy?: AgentPersonaAuthorityPolicy;
}): AgentPersonaRouteResolution {
  const definition = getBuiltInAgentPersona(input.personaId);
  const authorityPolicy = input.authorityPolicy ?? definition.authority.defaultPolicy;
  const rejectedTargets: Array<AgentPersonaRouteAttempt> = [];

  for (const [index, target] of definition.modelRoute.entries()) {
    const route = index === 0 ? "primary" : "fallback";
    const candidates = candidatesForTarget(input.providers, target);
    const failures: Array<AgentPersonaRouteFailure> = [];

    if (!providerCanEnforceAgentPersonaAuthority(target.driver, authorityPolicy)) {
      rejectedTargets.push({
        route,
        target,
        failures: [{ code: "authority-not-enforceable" }],
      });
      continue;
    }

    if (candidates.length === 0) {
      failures.push({ code: "provider-not-configured" });
    }

    for (const provider of candidates) {
      const reason = unavailableReason(provider, target);
      if (reason !== undefined) {
        failures.push({ code: reason, instanceId: provider.instanceId });
        continue;
      }

      const optionId = target.driver === "codex" ? "reasoningEffort" : "effort";
      return {
        status: "available",
        personaId: definition.id,
        definitionVersion: definition.version,
        route,
        driver: target.driver,
        modelSelection: {
          instanceId: provider.instanceId,
          model: target.model,
          options: [{ id: optionId, value: target.reasoningEffort }],
        },
        rejectedTargets,
      };
    }

    rejectedTargets.push({ route, target, failures });
  }

  return {
    status: "unavailable",
    personaId: definition.id,
    definitionVersion: definition.version,
    attempts: rejectedTargets,
  };
}

export function buildBuiltInAgentPersonaCatalog(
  providers: ReadonlyArray<ServerProvider>,
): OrchestrationV2AgentPersonaCatalog {
  return {
    personas: listBuiltInAgentPersonas().map((definition) => {
      const resolution = resolveBuiltInAgentPersonaRoute({
        personaId: definition.id,
        providers,
      });
      return {
        personaId: definition.id,
        displayName: definition.displayName,
        description: definition.description,
        acceptedInput: definition.acceptedInput,
        outputArtifact: definition.outputArtifact,
        defaultAuthorityPolicy: definition.authority.defaultPolicy,
        allowedAuthorityPolicies: [...definition.authority.allowedPolicies],
        availability:
          resolution.status === "available"
            ? {
                status: "available" as const,
                resolvedRoute: resolution.route,
                resolvedDriver: ProviderDriverKind.make(resolution.driver),
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
