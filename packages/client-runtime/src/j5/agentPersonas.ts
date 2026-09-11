import * as Schema from "effect/Schema";
import {
  AgentPersonaImportConflictError,
  isAgentPersonaDefinitionFile,
  AGENT_PERSONA_IMPORT_MAX_BYTES,
  AGENT_PERSONA_IMPORT_MAX_FILES,
} from "@t3tools/contracts";
import type {
  AgentPersonaAuthorityPolicy,
  AgentPersonaFolderGitStatus,
  AgentPersonaLibraryFolder,
  AgentPersonaOrigin,
  AgentPersonaUsage,
  AgentPersonaUsageEntry,
  AgentPersonaImportInput,
  AgentPersonaImportConflict,
  AgentPersonaDefinitionView,
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
  /** Removed source or bundled definitions stay listed with a Restore action. */
  readonly removed: boolean;
  readonly enabled: boolean;
  /** Everything the edit dialog needs except instructions, which it loads on open. */
  readonly edit: Omit<AgentPersonaEditInput, "instructions"> | null;
  /** Absent from older servers; present entries say where the definition in effect came from. */
  readonly origin: AgentPersonaOrigin | null;
  readonly originLabel: string | null;
  readonly displayName: string;
  readonly description: string;
  readonly acceptedInput: string | undefined;
  readonly outputArtifact: string | undefined;
  readonly authority: string;
  readonly availability: "available" | "blocked" | "disabled" | "removed";
  readonly availabilityLabel: "Available" | "Blocked" | "Disabled" | "Removed";
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
    const removed =
      persona.availability.status === "unavailable" && persona.availability.reason === "removed";
    return {
      personaId: persona.personaId,
      imported: persona.imported ?? false,
      removed,
      enabled: !disabled && !removed,
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
      origin: persona.origin ?? null,
      originLabel: persona.origin ? agentPersonaOriginLabel(persona.origin) : null,
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
      availability: removed
        ? "removed"
        : disabled
          ? "disabled"
          : available
            ? "available"
            : "blocked",
      availabilityLabel: removed
        ? "Removed"
        : disabled
          ? "Disabled"
          : available
            ? "Available"
            : "Blocked",
      route: available
        ? `${providerLabel(persona.availability.resolvedDriver)} · ${persona.availability.resolvedModelSelection.model} · ${persona.availability.resolvedRoute}`
        : persona.availability.reason === "authority-not-enforceable"
          ? "Required authority is not yet enforceable"
          : removed
            ? "Removed from this library"
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

export const AGENT_PERSONA_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Suggest a stable ID from a display name: lowercase, hyphenated, starting with a letter. */
export function agentPersonaIdFromName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "" : /^[a-z]/.test(slug) ? slug : `agent-${slug}`;
}

/** Human-readable reason an ID cannot be used, or null when it is acceptable. */
export function agentPersonaIdError(id: string): string | null {
  if (id.trim() === "") return "Enter an ID.";
  if (!AGENT_PERSONA_ID_PATTERN.test(id))
    return "Use lowercase letters, digits, and single hyphens, starting with a letter.";
  return null;
}

/** First advertised model per harness, so a new agent starts with a launchable route. */
export function defaultAgentPersonaModelRoute(
  providers: ReadonlyArray<ServerProvider>,
): [AgentPersonaModelTarget, AgentPersonaModelTarget] | null {
  const available = agentPersonaModelChoices(providers, []).filter(({ available }) => available);
  const primary = available[0];
  if (primary === undefined) return null;
  const fallback =
    available.find(({ target }) => target.driver !== primary.target.driver) ?? primary;
  return [primary.target, fallback.target];
}

export interface AgentPersonaCreateDraft {
  readonly displayName: string;
  readonly id: string;
  readonly description: string;
  readonly instructions: string;
  readonly authorityPolicy: AgentPersonaAuthorityPolicy;
  readonly modelRoute: readonly [AgentPersonaModelTarget, AgentPersonaModelTarget];
}

/** Prefill the create dialog from any listed agent; the copy gets its own name and ID. */
export function agentPersonaDuplicateDraft(
  definition: AgentPersonaDefinitionView,
): AgentPersonaCreateDraft {
  return {
    displayName: `${definition.displayName} copy`,
    id: agentPersonaIdFromName(`${definition.id}-copy`),
    description: definition.description,
    instructions: definition.instructions,
    authorityPolicy: definition.authority.defaultPolicy,
    modelRoute: definition.modelRoute,
  };
}

export type AgentPersonaDrift = "current" | "changed" | "unknown";

/**
 * Compare a thread's launch snapshot with the library's current definition. Legacy
 * snapshots without a digest, and agents no longer listed, cannot be compared.
 */
export function agentPersonaDrift(
  assignment: Pick<OrchestrationV2AgentPersonaAssignment, "personaId" | "definitionDigest">,
  catalog: OrchestrationV2AgentPersonaCatalog | null | undefined,
): AgentPersonaDrift {
  if (assignment.definitionDigest === undefined) return "unknown";
  const current = catalog?.personas.find(({ personaId }) => personaId === assignment.personaId);
  if (current?.definitionDigest === undefined) return "unknown";
  return current.definitionDigest === assignment.definitionDigest ? "current" : "changed";
}

export const AGENT_PERSONA_DRIFT_MESSAGE =
  "This agent's definition changed after this task launched. The task keeps the definition it started with; start a new task to use the current one.";

/** Short origin for a catalog row; folder origins name the file's parent folder only. */
export function agentPersonaOriginLabel(origin: AgentPersonaOrigin): string {
  switch (origin.kind) {
    case "bundled":
      return "Bundled example";
    case "imported":
      return "Personal";
    case "folder": {
      const segments = origin.path.split(/[\\/]+/).filter((segment) => segment !== "");
      const folder = segments.at(-2);
      return folder === undefined ? "Folder" : `Folder · ${folder}`;
    }
  }
}

const compactCount = (value: number): string =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
    : value >= 1_000
      ? `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`
      : String(value);

/** Whole-unit duration such as "45s", "2m 10s", or "1h 5m". */
export function formatAgentPersonaDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export interface AgentPersonaUsageSummary {
  readonly line: string;
  readonly routes: ReadonlyArray<string>;
}

/** One dense line per agent; absent metrics are left out rather than shown as zero. */
export function presentAgentPersonaUsage(entry: AgentPersonaUsageEntry): AgentPersonaUsageSummary {
  const parts = [
    `${entry.threads} ${entry.threads === 1 ? "task" : "tasks"}`,
    `${entry.runs} ${entry.runs === 1 ? "run" : "runs"}`,
  ];
  if (entry.runs > 0) parts.push(`${entry.completedRuns} completed`, `${entry.failedRuns} failed`);
  if (entry.averageRunDurationMs !== null)
    parts.push(`avg ${formatAgentPersonaDuration(entry.averageRunDurationMs)}`);
  if (entry.inputTokens !== null && entry.outputTokens !== null)
    parts.push(`${compactCount(entry.inputTokens)} in / ${compactCount(entry.outputTokens)} out`);
  if (entry.lastLaunchedAt !== null) parts.push(`last ${entry.lastLaunchedAt.slice(0, 10)}`);
  return {
    line: parts.join(" · "),
    routes: entry.routes.map(
      (route) =>
        `${providerLabel(route.driver)} · ${route.model} (${route.threads} ${route.threads === 1 ? "task" : "tasks"})`,
    ),
  };
}

export function agentPersonaUsageById(
  usage: AgentPersonaUsage | null | undefined,
): ReadonlyMap<string, AgentPersonaUsageEntry> {
  return new Map((usage?.personas ?? []).map((entry) => [entry.personaId, entry]));
}

/** The only git prompts the roles spec allows: uncommitted work and a remote that moved on. */
export function agentPersonaFolderNudges(
  git: AgentPersonaFolderGitStatus | null,
): ReadonlyArray<string> {
  if (git === null) return [];
  const nudges: string[] = [];
  if (git.uncommittedChanges)
    nudges.push("Uncommitted changes in this folder. Commit to share them.");
  if (git.remoteAhead !== null && git.remoteAhead > 0)
    nudges.push(
      `${git.remoteAhead} new ${git.remoteAhead === 1 ? "commit" : "commits"} on the remote. Pull to update this library.`,
    );
  return nudges;
}

export function agentPersonaFolderStatusLabel(folder: AgentPersonaLibraryFolder): string {
  if (!folder.exists) return "Missing";
  return `${folder.definitionCount} ${folder.definitionCount === 1 ? "definition" : "definitions"}`;
}
