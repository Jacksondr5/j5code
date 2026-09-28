import * as NodeCrypto from "node:crypto";
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";

import { CommCommandId } from "./contracts.ts";
import { PlacementCommandId } from "./placementContracts.ts";

/**
 * Stable ids for the J5 spawn lifecycle. Every id derives from the caller's provider session and
 * request key, so a retry with the same key replays the same thread, home, placement, and brief
 * commands instead of double-acting. Crew seats qualify the key per seat.
 */
export const stablePart = (value: string) => encodeURIComponent(value);

export interface SpawnStableInput {
  readonly providerSessionId: string;
  readonly requestKey: string;
}

export const lifecycleId = (
  input: SpawnStableInput & {
    readonly kind: "command" | "message" | "thread" | "crew" | "artifact";
    readonly operation: string;
  },
) =>
  [
    input.kind,
    "j5",
    "a2a",
    "mcp",
    stablePart(input.providerSessionId),
    stablePart(input.operation),
    stablePart(input.requestKey),
  ].join(":");

export const lifecycleCommandId = (input: SpawnStableInput & { readonly operation: string }) =>
  CommandId.make(lifecycleId({ kind: "command", ...input }));

// Thread ids become filenames (including base64 terminal history names); bound their length.
export const spawnThreadId = (input: SpawnStableInput) =>
  ThreadId.make(
    `thread:j5:a2a:${NodeCrypto.createHash("sha256")
      .update(JSON.stringify([input.providerSessionId, input.requestKey]))
      .digest("hex")}`,
  );

export const spawnCrewInstanceId = (input: SpawnStableInput) =>
  lifecycleId({ kind: "crew", operation: "spawn-crew", ...input });

/** Each seat is an ordinary spawn with a seat-qualified request key, so retries replay per seat. */
export const crewSeatRequestKey = (requestKey: string, seatName: string) =>
  `${requestKey}/seat/${seatName}`;

export const spawnMessageId = (input: SpawnStableInput) =>
  MessageId.make(lifecycleId({ kind: "message", operation: "spawn-brief", ...input }));

export const spawnHomeCommandId = (input: SpawnStableInput) =>
  CommCommandId.make(lifecycleId({ kind: "command", operation: "spawn-home", ...input }));

export const spawnPlacementCommandId = (input: SpawnStableInput) =>
  PlacementCommandId.make(lifecycleId({ kind: "command", operation: "spawn-placement", ...input }));

export const spawnTitle = (brief: string, title: string | undefined): string => {
  const value = title?.trim() || brief.trim();
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
};

/** What a seat's first turn needs to know about its Crew; instructions are content, verbatim. */
export interface CrewBriefContext {
  readonly displayName: string;
  readonly instanceId: string;
  readonly seatName: string;
  readonly seatInstructions?: string | undefined;
  readonly captainParticipantId: string;
  /** The handoff this seat's agent definition returns, and the shared artifact file it goes to. */
  readonly obligation?: { readonly kind: string; readonly path: string } | undefined;
  readonly roster: ReadonlyArray<{
    readonly seat: string;
    readonly participantId: string;
    readonly agentDisplayName: string;
  }>;
}

// The web timeline parses the identity block and the trailing brief
// (apps/web/src/j5/a2a/SpawnBrief.tsx) to attribute the message to its spawner;
// keep the two in step.
export const spawnFirstTurnText = (input: {
  readonly brief: string;
  readonly participantId: string;
  readonly squadronId: string;
  readonly squadronName: string;
  readonly spawnedByParticipantId: string;
  readonly spawnerThreadId: string;
  readonly crew?: CrewBriefContext;
}) => {
  const identity = `<j5_spawn_context>\nPlatform-provided identity facts:\nparticipant_id: ${input.participantId}\nsquadron_id: ${input.squadronId}\nsquadron_name: ${input.squadronName}\nspawned_by: ${input.spawnedByParticipantId}\nspawner_thread_id: ${input.spawnerThreadId}\n</j5_spawn_context>`;
  const brief = `<spawner_brief>\n${input.brief}\n</spawner_brief>`;
  if (input.crew === undefined) return `${identity}\n\n${brief}`;
  const crew = input.crew;
  // Roster and identity are measured platform facts; wiring text is the user's content, verbatim.
  const roster = crew.roster
    .map(
      (member) =>
        `- ${member.seat}${member.seat === crew.seatName ? " (you)" : ""}: participant_id=${member.participantId} persona=${member.agentDisplayName}`,
    )
    .join("\n");
  const crewContext = `<j5_crew_context>\nPlatform-provided crew facts:\ncrew: ${crew.displayName}\ncrew_instance_id: ${crew.instanceId}\nyour_seat: ${crew.seatName}\ncaptain_participant_id: ${crew.captainParticipantId}\nroster:\n${roster}\n</j5_crew_context>`;
  const seatInstructions =
    crew.seatInstructions === undefined
      ? []
      : [`<seat_instructions>\n${crew.seatInstructions}\n</seat_instructions>`];
  const collaboration = `<crew_collaboration>\nResolve current participants with list_participants and use send_message to coordinate directly with your Captain and other members. Share useful findings, evidence, questions, and blockers immediately; do not wait for an artifact or coordination approval. Send your Captain your final result, supporting evidence, and any remaining blockers before finishing. If the roster lacks expertise needed to address a concern, tell your Captain what is missing and why so they can request_crew_member through the user's inbox. Continue already-approved work and coordination while an addition is pending. A direct result is sufficient unless the user or your persona explicitly requires an artifact.\n</crew_collaboration>`;
  // A persona's declared deliverable supplements the conversation; it never gates coordination.
  const obligation =
    crew.obligation === undefined
      ? []
      : [
          `<seat_obligation>\nYour agent definition returns a ${crew.obligation.kind}. Before you finish, write it with write_artifact to exactly \`${crew.obligation.path}\` as Markdown (your instructions list the required contents); this is in addition to direct messages and must not delay sharing intermediate findings or results. Your Captain is told when the file appears; rewrite the same path to revise it.\n</seat_obligation>`,
        ];
  return [identity, crewContext, collaboration, ...seatInstructions, ...obligation, brief].join(
    "\n\n",
  );
};
