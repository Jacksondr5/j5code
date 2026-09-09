import type { OrchestrationV2AgentPersonaCatalog } from "@t3tools/contracts";

/** Stable IDs keep mentions unambiguous when display names are edited or duplicated. */
export function agentPersonaMentionItems(
  catalog: OrchestrationV2AgentPersonaCatalog | null,
  query: string,
) {
  const search = query.trim().toLowerCase();
  return (catalog?.personas ?? [])
    .filter(
      (persona) =>
        persona.availability.status === "available" &&
        [persona.personaId, persona.displayName, persona.description].some((value) =>
          value.toLowerCase().includes(search),
        ),
    )
    .toSorted((a, b) => a.displayName.localeCompare(b.displayName))
    .slice(0, 20)
    .map((persona) => ({
      id: `agent:${persona.personaId}`,
      type: "agent" as const,
      personaId: persona.personaId,
      label: persona.displayName,
      description: persona.description,
    }));
}
