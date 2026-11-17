import type * as J5Contracts from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";

import type { CrewProposal } from "./AgentCrewProposalService.ts";

/** Legacy fixed-plan metadata stays readable in storage but is not part of the roster card. */
export const projectCrewProposal =
  (_playbooks: unknown) =>
  ({ playbook: _playbook, ...proposal }: CrewProposal): Effect.Effect<J5Contracts.CrewProposal> =>
    Effect.succeed({
      ...proposal,
      playbook: null,
      requestedSeats: proposal.requestedSeats.map(
        ({ steps: _steps, personaSwaps: _swaps, ...seat }) => seat,
      ),
      approvedSeats:
        proposal.approvedSeats?.map(({ steps: _steps, personaSwaps: _swaps, ...seat }) => seat) ??
        null,
    });
