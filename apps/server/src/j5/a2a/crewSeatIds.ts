import { participantIdForThread } from "./HomeRegistrar.ts";
import {
  crewSeatRequestKey,
  spawnMessageId,
  spawnThreadId,
  type SpawnStableInput,
} from "./spawnIds.ts";

/**
 * Resolution-time spawns key off the proposal id, so a retried approval replays the same seats
 * and the launch report, the decline cleanup, and the seat notices all find a seat by derivation
 * rather than by lookup.
 */
export const CREW_PROPOSAL_SESSION = "j5-crew-proposal";

export const crewSeatSpawnInput = (proposalId: string, seatName: string): SpawnStableInput => ({
  providerSessionId: CREW_PROPOSAL_SESSION,
  requestKey: crewSeatRequestKey(proposalId, seatName),
});

export const crewSeatThreadId = (proposalId: string, seatName: string) =>
  spawnThreadId(crewSeatSpawnInput(proposalId, seatName));

/** The message that starts a seat's first turn: its run is the one a launch report watches. */
export const crewSeatBriefMessageId = (proposalId: string, seatName: string) =>
  spawnMessageId(crewSeatSpawnInput(proposalId, seatName));

/** Whether a member row was minted by this proposal: its ids derive from the proposal id. */
export const crewSeatReservedBy =
  (proposalId: string) => (member: { readonly participantId: string; readonly seatName: string }) =>
    member.participantId === participantIdForThread(crewSeatThreadId(proposalId, member.seatName));
