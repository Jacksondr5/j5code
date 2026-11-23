import type * as J5Contracts from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";

import type { PlaybookStore } from "../playbooks/PlaybookStore.ts";
import type { CrewProposal } from "./AgentCrewProposalService.ts";
import { crewPlaybookSummary } from "./crewPlaybookPlan.ts";

/**
 * A proposal as the card reads it: its playbook projected from the live YAML. A definition that
 * cannot be read, or has lost a step a seat claims, becomes the playbook's issue rather than a
 * failed read.
 */
export const projectCrewProposal =
  (playbooks: Pick<PlaybookStore["Service"], "readPath">) =>
  ({ playbook, ...proposal }: CrewProposal): Effect.Effect<J5Contracts.CrewProposal> =>
    playbook == null
      ? Effect.succeed({ ...proposal, playbook: null })
      : playbooks.readPath(playbook.definitionPath).pipe(
          Effect.map((definition) => {
            const ids = new Set(definition.steps.map(({ id }) => id));
            const lost = proposal.requestedSeats
              .flatMap((seat) => seat.steps ?? [])
              .find((id) => !ids.has(id));
            return {
              ...proposal,
              playbook: crewPlaybookSummary(
                playbook.name,
                definition,
                lost === undefined
                  ? null
                  : `Step ${lost} is no longer in the playbook; approving is refused until the Captain proposes again.`,
              ),
            };
          }),
          Effect.catch((error) =>
            Effect.succeed({
              ...proposal,
              playbook: {
                name: playbook.name,
                title: playbook.name,
                steps: [],
                issue: error.message,
              },
            }),
          ),
        );
