import type { CrewPersonaSwap, CrewProposalPlaybook, PlaybookStep } from "@t3tools/contracts/j5";

import { personaCatalogProblem } from "../agents/agentPersonaLibrary.ts";
import type { CrewProposalSeat } from "./AgentCrewProposalService.ts";

export interface CrewPlaybookPlanInput {
  /** The live definition the Crew follows; null when it follows none. */
  readonly definition: {
    readonly name: string;
    readonly title: string;
    readonly steps: ReadonlyArray<PlaybookStep>;
  } | null;
  readonly seats: ReadonlyArray<CrewProposalSeat>;
  /** A live Crew's members, for an addition; empty for a new roster. */
  readonly existingMembers: ReadonlyArray<{
    readonly seatName: string;
    readonly playbookStepIds: ReadonlyArray<string>;
  }>;
  readonly catalog: Parameters<typeof personaCatalogProblem>[0];
}

export type CrewPlaybookPlan =
  | { readonly problem: { readonly detail: string; readonly nextStep: string } }
  | {
      readonly problem: null;
      /** The card-visible playbook; null when the Crew follows none. */
      readonly summary: CrewProposalPlaybook | null;
      /** Step ids no seat owns, in YAML order; the Captain does them. */
      readonly unownedSteps: ReadonlyArray<string>;
      /** Each seat's swaps, in seat order; seats without swaps are absent. */
      readonly swapsBySeat: ReadonlyMap<string, ReadonlyArray<CrewPersonaSwap>>;
    };

/** The card-visible projection of a live definition; `issue` says what no longer matches. */
export const crewPlaybookSummary = (
  name: string,
  definition: { readonly title: string; readonly steps: ReadonlyArray<PlaybookStep> },
  issue: string | null = null,
): CrewProposalPlaybook => ({
  name,
  title: definition.title,
  steps: definition.steps.map(({ id, title, persona }) =>
    persona === undefined ? { id, title } : { id, title, persona },
  ),
  issue,
});

/**
 * The rules every door that accepts a roster applies to a playbook Crew: each claimed step exists
 * and has one owner, and a Crew without a playbook owns no steps. The member store enforces
 * ownership again when it writes rows; this check gives the early, specific refusal.
 */
export function planCrewPlaybook(input: CrewPlaybookPlanInput): CrewPlaybookPlan {
  const { definition } = input;
  if (definition === null) {
    const claimant = input.seats.find((seat) => (seat.steps?.length ?? 0) > 0);
    return claimant === undefined
      ? { problem: null, summary: null, unownedSteps: [], swapsBySeat: new Map() }
      : {
          problem: {
            detail: `Seat ${claimant.seat} lists steps, but the crew follows no playbook.`,
            nextStep:
              "Name a playbook from playbook_list when you propose the crew, or leave steps out.",
          },
        };
  }
  const steps = new Map(definition.steps.map((step) => [step.id, step]));
  const owners = new Map<string, string>();
  for (const member of input.existingMembers)
    for (const stepId of member.playbookStepIds) owners.set(stepId, member.seatName);
  const swapsBySeat = new Map<string, ReadonlyArray<CrewPersonaSwap>>();
  for (const seat of input.seats) {
    const swaps: Array<CrewPersonaSwap> = [];
    for (const stepId of seat.steps ?? []) {
      const step = steps.get(stepId);
      if (step === undefined)
        return {
          problem: {
            detail: `Seat ${seat.seat} lists step ${stepId}, which playbook ${definition.name} does not have.`,
            nextStep: `Call playbook_read for ${definition.name} and use its step ids.`,
          },
        };
      const owner = owners.get(stepId);
      if (owner !== undefined)
        return {
          problem: {
            detail:
              owner === seat.seat
                ? `Seat ${seat.seat} lists step ${stepId} twice.`
                : input.existingMembers.some((member) => member.seatName === owner)
                  ? `Step ${stepId} is already owned by seat ${owner}.`
                  : `Step ${stepId} is claimed by seat ${owner} and seat ${seat.seat}; a step has one owner.`,
            nextStep: "Give each step to one seat, or leave it unowned for the Captain.",
          },
        };
      owners.set(stepId, seat.seat);
      if (step.persona !== undefined && step.persona !== seat.agentId)
        swaps.push({
          stepId,
          wanted: step.persona,
          seatPersona: seat.agentId,
          wantedProblem: personaCatalogProblem(input.catalog, step.persona),
        });
    }
    if (swaps.length > 0) swapsBySeat.set(seat.seat, swaps);
  }
  return {
    problem: null,
    summary: crewPlaybookSummary(definition.name, definition),
    unownedSteps: definition.steps.map(({ id }) => id).filter((id) => !owners.has(id)),
    swapsBySeat,
  };
}

/** The seats as stored: every client-sent swap replaced by the server's computation. */
export const withPersonaSwaps = (
  seats: ReadonlyArray<CrewProposalSeat>,
  swapsBySeat: ReadonlyMap<string, ReadonlyArray<CrewPersonaSwap>>,
): ReadonlyArray<CrewProposalSeat> =>
  seats.map(({ personaSwaps: _client, ...seat }) => {
    const swaps = swapsBySeat.get(seat.seat);
    return swaps === undefined ? seat : { ...seat, personaSwaps: swaps };
  });
