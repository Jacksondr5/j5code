import * as Schema from "effect/Schema";
import {
  AgentPersonaImportConflictError,
  isAgentPersonaDefinitionFile,
  AGENT_PERSONA_IMPORT_MAX_BYTES,
  AGENT_PERSONA_IMPORT_MAX_FILES,
} from "@t3tools/contracts";
import type {
  AgentPersonaAuthorityPolicy,
  AgentPersonaImportInput,
  AgentPersonaImportConflict,
  AgentPersonaEditInput,
  AgentPersonaModelTarget,
  ServerProvider,
  AgentPersonaId,
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
  readonly personaId: AgentPersonaId;
  readonly imported: boolean;
  readonly enabled: boolean;
  readonly edit: AgentPersonaEditInput | null;
  readonly displayName: string;
  readonly description: string;
  readonly acceptedInput: string;
  readonly outputArtifact: string;
  readonly authority: string;
  readonly availability: "available" | "blocked" | "disabled";
  readonly availabilityLabel: "Available" | "Blocked" | "Disabled";
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
  const name =
    assignment.displayName ??
    `${assignment.personaId[0]?.toUpperCase()}${assignment.personaId.slice(1)}`;
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
    const disabled =
      persona.availability.status === "unavailable" && persona.availability.reason === "disabled";
    return {
      personaId: persona.personaId,
      imported: persona.imported ?? false,
      enabled: !disabled,
      edit:
        persona.imported && persona.editable
          ? {
              personaId: persona.personaId,
              expectedDigest: persona.editable.definitionDigest,
              displayName: persona.displayName,
              description: persona.description,
              authorityPolicy: persona.defaultAuthorityPolicy,
              modelRoute: persona.editable.modelRoute,
            }
          : null,
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
      availability: disabled ? "disabled" : available ? "available" : "blocked",
      availabilityLabel: disabled ? "Disabled" : available ? "Available" : "Blocked",
      route: available
        ? `${providerLabel(persona.availability.resolvedDriver)} · ${persona.availability.resolvedModelSelection.model} · ${persona.availability.resolvedRoute}`
        : persona.availability.reason === "authority-not-enforceable"
          ? "Required authority is not yet enforceable"
          : disabled
            ? "Disabled for new launches"
            : "Primary and fallback models unavailable",
    };
  });
}

/** Read only selected YAML files; paths are labels, never server filesystem destinations. */
export async function prepareAgentPersonaImport(
  files: ReadonlyArray<{
    readonly name: string;
    readonly size: number;
    readonly text: () => Promise<string>;
  }>,
) {
  const definitions = files.filter((file) => isAgentPersonaDefinitionFile(file.name));
  if (definitions.length === 0)
    throw new Error("No YAML agent definitions found in the selection.");
  if (definitions.length > AGENT_PERSONA_IMPORT_MAX_FILES)
    throw new Error(
      `Select at most ${AGENT_PERSONA_IMPORT_MAX_FILES} agent definitions at a time.`,
    );
  const result: Array<{ name: string; content: string }> = [];
  for (const file of definitions) {
    if (file.size > AGENT_PERSONA_IMPORT_MAX_BYTES) throw new Error(`${file.name} exceeds 64 KiB.`);
    result.push({ name: file.name, content: await file.text() });
  }
  return result;
}

export const AGENT_PERSONA_POLICY_OPTIONS = [
  { value: "read-only", label: "Read only" },
  { value: "workspace-write", label: "Workspace write" },
  { value: "critic-review", label: "Review only" },
  { value: "critic-fix", label: "Targeted fixes" },
  { value: "diagnostic", label: "Diagnostic writes (not yet supported)" },
  { value: "publish-only", label: "Publish only (not yet supported)" },
] as const satisfies ReadonlyArray<{ value: AgentPersonaAuthorityPolicy; label: string }>;

export const agentPersonaModelChoiceId = (target: AgentPersonaModelTarget) =>
  JSON.stringify([target.driver, target.model]);

export const AGENT_PERSONA_HARNESSES = [
  { driver: "codex", label: "Codex" },
  { driver: "claudeAgent", label: "Claude" },
] as const;

/** Retain configured models while limiting new selections to supported reasoning levels. */
export function agentPersonaModelChoices(
  providers: ReadonlyArray<ServerProvider>,
  current: ReadonlyArray<AgentPersonaModelTarget>,
) {
  const choices = new Map<
    string,
    {
      id: string;
      label: string;
      modelLabel: string;
      available: boolean;
      target: AgentPersonaModelTarget;
      efforts: string[];
    }
  >();
  for (const provider of providers) {
    if (!provider.enabled || !provider.installed || provider.auth.status !== "authenticated")
      continue;
    if (provider.driver !== "codex" && provider.driver !== "claudeAgent") continue;
    const driver = provider.driver === "codex" ? "codex" : "claudeAgent";
    for (const model of provider.models) {
      const descriptor = model.capabilities?.optionDescriptors?.find(
        ({ id }) => id === (driver === "codex" ? "reasoningEffort" : "effort"),
      );
      if (descriptor?.type !== "select" || descriptor.options.length === 0) continue;
      const efforts = descriptor.options.map(({ id }) => id);
      const target = {
        driver,
        model: model.slug,
        reasoningEffort: efforts.includes("high") ? "high" : efforts[0]!,
      } satisfies AgentPersonaModelTarget;
      const id = agentPersonaModelChoiceId(target);
      const previous = choices.get(id);
      choices.set(id, {
        id,
        label: `${driver === "codex" ? "Codex" : "Claude"} · ${model.slug}`,
        modelLabel: model.slug,
        available: true,
        target,
        efforts: [...new Set([...(previous?.efforts ?? []), ...efforts])],
      });
    }
  }
  const advertisedIds = new Set(choices.keys());
  for (const target of current) {
    const id = agentPersonaModelChoiceId(target);
    if (advertisedIds.has(id)) continue;
    const previous = choices.get(id);
    const efforts = [...new Set([...(previous?.efforts ?? []), target.reasoningEffort])];
    choices.set(id, {
      id,
      label: `${target.driver === "codex" ? "Codex" : "Claude"} · ${target.model} (not advertised)`,
      modelLabel: `${target.model} (not advertised)`,
      available: false,
      target,
      efforts,
    });
  }
  return [...choices.values()].sort((a, b) => a.label.localeCompare(b.label));
}

const isImportConflict = Schema.is(AgentPersonaImportConflictError);

/** Import new agents and approved replacements, retaining skipped IDs across confirmations. */
export async function importAgentPersonasWithConfirmation(
  files: AgentPersonaImportInput["files"],
  request: (
    input: AgentPersonaImportInput,
  ) => Promise<{ readonly importedIds: ReadonlyArray<string> }>,
  confirm: (
    error: AgentPersonaImportConflictError,
  ) => Promise<ReadonlyArray<AgentPersonaImportConflict> | null>,
) {
  let input: AgentPersonaImportInput = { files, replaceExisting: false };
  const skippedPersonaIds = new Set<string>();
  while (true) {
    try {
      return await request(input);
    } catch (error) {
      if (!isImportConflict(error)) throw error;
      const selected = await confirm(error);
      if (selected === null) return null;
      for (const conflict of error.conflicts) {
        if (!selected.some(({ personaId }) => personaId === conflict.personaId))
          skippedPersonaIds.add(conflict.personaId);
      }
      input = {
        files,
        replaceExisting: true,
        confirmedConflicts: selected,
        skippedPersonaIds: [...skippedPersonaIds],
      };
    }
  }
}

export const AGENT_PERSONA_IMPORT_CONFIRMATION_MESSAGE =
  "Turn off agents you don’t want to replace.";
