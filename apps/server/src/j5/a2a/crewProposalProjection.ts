import type * as J5Contracts from "@t3tools/contracts/j5";

import type { CrewProposal } from "./AgentCrewProposalService.ts";

/** Legacy fixed-plan metadata stays readable in storage but is not part of the roster card. */
export const projectCrewProposal = ({
  playbook: _playbook,
  ...proposal
}: CrewProposal): J5Contracts.CrewProposal => ({
  ...proposal,
  playbook: null,
  requestedSeats: proposal.requestedSeats.map(
    ({ steps: _steps, personaSwaps: _swaps, ...seat }) => seat,
  ),
  approvedSeats:
    proposal.approvedSeats?.map(({ steps: _steps, personaSwaps: _swaps, ...seat }) => seat) ?? null,
});
