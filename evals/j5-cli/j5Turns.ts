/**
 * Turns J5's server builds, rendered from source so a case never copies their text. A case names
 * each one under `j5Turns` and places it with `{{j5:<name>}}` in its prompt or an earlier turn's
 * text; the case supplies only the facts (brief, roster, message bodies).
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { AgentCrewInstance } from "../../apps/server/src/j5/a2a/AgentCrewInstanceService.ts";
import type { CrewProposal } from "../../apps/server/src/j5/a2a/AgentCrewProposalService.ts";
import type { LedgerProjectId, ParticipantId } from "../../apps/server/src/j5/a2a/contracts.ts";
import { crewLaunchReportText } from "../../apps/server/src/j5/a2a/crewGateNotice.ts";
import { deliveryContext } from "../../apps/server/src/j5/a2a/CrewTurnContext.ts";
import { formatPeerEnvelope } from "../../apps/server/src/j5/a2a/EnvelopeFormatter.ts";
import { spawnFirstTurnText } from "../../apps/server/src/j5/a2a/spawnIds.ts";
import type { McpToolUseCase } from "../mcp-tool-use/run.ts";
import { PROJECT } from "./j5Results.ts";
import { setSteer, Steer } from "./steer.ts";

const PeerMessage = Schema.Struct({
  from: Schema.String,
  message: Schema.String,
  exchangeId: Schema.optional(Schema.String),
});
const Member = Schema.Struct({
  seat: Schema.String,
  participantId: Schema.String,
  threadId: Schema.String,
  /** A saved persona id; a custom seat has none. */
  persona: Schema.optional(Schema.String),
  responsibility: Schema.String,
});
const Crew = Schema.Struct({
  name: Schema.String,
  instanceId: Schema.String,
  captainParticipantId: Schema.String,
  captainThreadId: Schema.String,
  brief: Schema.String,
  roster: Schema.Array(Member),
});

/** A seat's first turn: the Crew context CrewTurnContext puts ahead of the Captain's first message. */
const CrewFirstTurn = Schema.Struct({
  crewFirstTurn: Schema.Struct({ crew: Crew, seat: Schema.String, assignment: PeerMessage }),
});
/** A message from another agent, as the delivery worker wraps it. */
const PeerTurn = Schema.Struct({ peerMessage: PeerMessage });
/** The Captain's launch report for an approved roster whose seats wait for their first work. */
const LaunchReport = Schema.Struct({
  crewLaunchReport: Schema.Struct({ crew: Crew, proposalId: Schema.String }),
});

export const J5Turns = Schema.Record(
  Schema.String,
  Schema.Union([CrewFirstTurn, PeerTurn, LaunchReport]),
);
type J5Turn = (typeof J5Turns.Type)[string];

const envelope = (message: typeof PeerMessage.Type) =>
  formatPeerEnvelope({
    senderId: message.from as ParticipantId,
    originProjectId: PROJECT.project_id as LedgerProjectId,
    originProjectTitle: PROJECT.project_title,
    exchangeId: (message.exchangeId ?? null) as Parameters<
      typeof formatPeerEnvelope
    >[0]["exchangeId"],
    message: message.message,
  });

const render = (turn: J5Turn): string => {
  if ("peerMessage" in turn) return envelope(turn.peerMessage);
  if ("crewFirstTurn" in turn) {
    const { crew, seat, assignment } = turn.crewFirstTurn;
    const self = crew.roster.find((member) => member.seat === seat);
    if (self === undefined) throw new Error(`Seat ${seat} is not on the roster.`);
    const first = spawnFirstTurnText({
      brief: crew.brief,
      participantId: self.participantId,
      projectId: PROJECT.project_id,
      projectTitle: PROJECT.project_title,
      spawnedByParticipantId: crew.captainParticipantId,
      spawnerThreadId: crew.captainThreadId,
      crew: {
        displayName: crew.name,
        instanceId: crew.instanceId,
        seatName: seat,
        captainParticipantId: crew.captainParticipantId,
        roster: crew.roster.map((member) => ({
          seat: member.seat,
          participantId: member.participantId,
          agentDisplayName: member.persona ?? "custom",
          reason: member.responsibility,
        })),
      },
    });
    return `${deliveryContext(first)}${envelope(assignment)}`;
  }
  const { crew, proposalId } = turn.crewLaunchReport;
  const seats = crew.roster.map((member) => ({
    seat: member.seat,
    agentId: member.persona ?? null,
    reason: member.responsibility,
  }));
  const proposal = {
    id: proposalId,
    kind: "roster",
    approvalMode: "human",
    displayName: crew.name,
    requestedSeats: seats,
    approvedSeats: seats,
  } as unknown as CrewProposal;
  const instance = {
    id: crew.instanceId,
    version: 1,
    members: crew.roster.map((member) => ({
      seatName: member.seat,
      agentId: member.persona ?? null,
      participantId: member.participantId as ParticipantId,
      threadId: member.threadId as ThreadId,
      addedVersion: 1,
      reason: member.responsibility,
      notStarted: true,
    })),
  } as unknown as AgentCrewInstance;
  return crewLaunchReportText({
    proposal,
    instance,
    verdicts: new Map(crew.roster.map((member) => [member.seat, { kind: "waiting" } as const])),
    windowMs: 0,
  });
};

const decodeTurns = Schema.decodeUnknownSync(J5Turns);
const decodeSteer = Schema.decodeUnknownSync(Steer);

/** The case with each `{{j5:<name>}}` in its prompt, earlier turns and steer replaced by that turn. */
export const withJ5Turns = (testCase: McpToolUseCase, raw: unknown): McpToolUseCase => {
  const { j5Turns: spec, steer } = raw as { readonly j5Turns?: unknown; readonly steer?: unknown };
  if (spec === undefined && steer === undefined) return testCase;
  const turns = spec === undefined ? {} : decodeTurns(spec);
  const fill = (text: string) =>
    text.replace(/\{\{j5:([\w-]+)\}\}/g, (_, name: string) => {
      const turn = turns[name];
      if (turn === undefined) throw new Error(`${testCase.id}: no j5Turns entry named ${name}.`);
      return render(turn);
    });
  const filled: McpToolUseCase = {
    ...testCase,
    prompt: fill(testCase.prompt),
    setup: {
      ...testCase.setup,
      ...(testCase.setup.priorTurns === undefined
        ? {}
        : {
            priorTurns: testCase.setup.priorTurns.map((turn) =>
              turn.text === undefined ? turn : { ...turn, text: fill(turn.text) },
            ),
          }),
    },
  };
  if (steer === undefined) return filled;
  const decoded = decodeSteer(steer);
  return setSteer(filled, { ...decoded, message: fill(decoded.message) });
};
