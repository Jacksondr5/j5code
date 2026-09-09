import type { OrchestrationV2AgentPersonaCatalog } from "@t3tools/contracts";
import { agentMentionReplacement } from "@t3tools/shared/j5/agentMention";

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

/**
 * Insert a picked agent through the host composer's own replacement routine, replacing exactly
 * the typed trigger. Returns the routine's result so the caller can clear its highlight.
 */
export function applyAgentMentionSelection(
  item: { readonly personaId: string },
  trigger: { readonly rangeStart: number; readonly rangeEnd: number },
  text: string,
  apply: (
    rangeStart: number,
    rangeEnd: number,
    replacement: string,
    options: { readonly expectedText: string },
  ) => boolean,
): boolean {
  return apply(trigger.rangeStart, trigger.rangeEnd, agentMentionReplacement(item.personaId), {
    expectedText: text.slice(trigger.rangeStart, trigger.rangeEnd),
  });
}
