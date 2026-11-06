import {
  agentPersonaEntryLabel,
  type AgentPersonaCatalogRow,
} from "@t3tools/client-runtime/j5/agent-personas";
import type { ServerProvider, AgentPersonaModelEntry } from "@t3tools/contracts";

export interface PersonaDetailRow {
  readonly label: string;
  readonly value: string;
  readonly tone?: "danger";
}

/**
 * What the read-only sheet shows for a persona the person can't edit. Models come from the
 * definition, read on open: `null` while it loads, and the catalog's resolved route if it fails.
 */
export function personaDetailRows(
  persona: Pick<
    AgentPersonaCatalogRow,
    | "origin"
    | "originLabel"
    | "authority"
    | "description"
    | "availabilityLabel"
    | "blockedReasons"
    | "route"
  >,
  models:
    | { readonly status: "loading" }
    | { readonly status: "failed" }
    | {
        readonly status: "loaded";
        readonly route: ReadonlyArray<AgentPersonaModelEntry>;
        readonly models?: ReadonlyArray<AgentPersonaModelEntry>;
      },
  usageLine: string | null,
  providers: ReadonlyArray<ServerProvider> = [],
): ReadonlyArray<PersonaDetailRow> {
  const source = persona.origin?.kind === "folder" ? persona.origin.path : persona.originLabel;
  return [
    { label: "Status", value: persona.availabilityLabel },
    ...persona.blockedReasons.map((reason) => ({
      label: "Reason",
      value: reason,
      tone: "danger" as const,
    })),
    ...(source === null ? [] : [{ label: "Source", value: source }]),
    { label: "Access", value: persona.authority },
    ...(models.status === "loaded"
      ? (models.models ?? models.route).map((entry, index) => {
          const label = agentPersonaEntryLabel(entry, providers);
          return {
            label: `Model ${index + 1}`,
            value: [label.provider, entry.model, label.reasoning]
              .filter((part) => part !== undefined)
              .join(" · "),
          };
        })
      : [{ label: "Model", value: models.status === "loading" ? "Loading…" : persona.route }]),
    { label: "Description", value: persona.description },
    ...(usageLine === null ? [] : [{ label: "Usage", value: usageLine }]),
  ];
}
