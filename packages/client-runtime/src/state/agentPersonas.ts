import type {
  AgentPersonaAuthorityPolicy,
  BuiltInAgentPersonaId,
  OrchestrationV2AgentPersonaAssignment,
  OrchestrationV2AgentPersonaCatalog,
} from "@t3tools/contracts";

const AUTHORITY_LABELS: Readonly<Record<AgentPersonaAuthorityPolicy, string>> = {
  "read-only": "Read only",
  "workspace-write": "Workspace write",
  "critic-review": "Review only",
  "critic-fix": "Targeted fixes",
  diagnostic: "Diagnostic writes",
  "publish-only": "Publish only",
};

export interface AgentPersonaCatalogRow {
  readonly personaId: BuiltInAgentPersonaId;
  readonly displayName: string;
  readonly description: string;
  readonly acceptedInput: string;
  readonly outputArtifact: string;
  readonly authority: string;
  readonly availability: "available" | "blocked";
  readonly availabilityLabel: "Available" | "Blocked";
  readonly route: string;
}

export interface AgentPersonaAssignmentPresentation {
  readonly personaLabel: string;
  readonly routeLabel: string;
}

function providerLabel(driver: OrchestrationV2AgentPersonaAssignment["resolvedDriver"]): string {
  return driver === "claudeAgent" ? "Claude" : "Codex";
}

export function presentAgentPersonaAssignment(
  assignment: OrchestrationV2AgentPersonaAssignment,
): AgentPersonaAssignmentPresentation {
  const name = `${assignment.personaId[0]?.toUpperCase()}${assignment.personaId.slice(1)}`;
  const mode =
    assignment.authorityPolicy === "critic-fix"
      ? " · Fix"
      : assignment.personaId === "critic"
        ? " · Review"
        : "";
  const provider = providerLabel(assignment.resolvedDriver);
  const effort = assignment.resolvedModelSelection.options?.find(
    ({ id }) => id === "reasoningEffort" || id === "effort",
  )?.value;

  return {
    personaLabel: `${name}${mode}`,
    routeLabel: [provider, assignment.resolvedModelSelection.model, effort]
      .filter((part) => part !== undefined)
      .join(" · "),
  };
}

export function presentAgentPersonaCatalog(
  catalog: OrchestrationV2AgentPersonaCatalog,
): ReadonlyArray<AgentPersonaCatalogRow> {
  return catalog.personas.map((persona) => {
    const available = persona.availability.status === "available";
    return {
      personaId: persona.personaId,
      displayName: persona.displayName,
      description: persona.description,
      acceptedInput: persona.acceptedInput,
      outputArtifact: persona.outputArtifact,
      authority: persona.allowedAuthorityPolicies
        .map(
          (policy) =>
            `${AUTHORITY_LABELS[policy]}${policy === persona.defaultAuthorityPolicy ? " (default)" : ""}`,
        )
        .join(", "),
      availability: available ? "available" : "blocked",
      availabilityLabel: available ? "Available" : "Blocked",
      route: available
        ? `${providerLabel(persona.availability.resolvedDriver)} · ${persona.availability.resolvedModelSelection.model} · ${persona.availability.resolvedRoute}`
        : persona.availability.reason === "authority-not-enforceable"
          ? "Required authority is not yet enforceable"
          : "Primary and fallback models unavailable",
    };
  });
}
