import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { CREW_NAME_MAX_CHARS, CREW_REASON_MAX_CHARS, CREW_TEXT_MAX_CHARS } from "./crewLimits.ts";
import { ParticipantId, SquadronId } from "./contracts.ts";

// The same bounds as the MCP verbs: the human's card edits arrive over HTTP and must not be the
// one way to store an unbounded or empty seat (Sentry S-3, 2026-09-14).
const bounded = (max: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));

/** One requested or approved seat. Reasons and instructions are the Captain's content, verbatim. */
export const CrewProposalSeat = Schema.Struct({
  seat: bounded(CREW_NAME_MAX_CHARS),
  agentId: bounded(CREW_NAME_MAX_CHARS),
  reason: bounded(CREW_REASON_MAX_CHARS),
  instructions: Schema.optional(bounded(CREW_TEXT_MAX_CHARS)),
});
export type CrewProposalSeat = typeof CrewProposalSeat.Type;

const Seats = Schema.Array(CrewProposalSeat);
const decodeSeats = Schema.decodeUnknownSync(Schema.fromJsonString(Seats));
const encodeSeats = Schema.encodeSync(Schema.fromJsonString(Seats));

export type CrewProposalKind = "roster" | "addition";
/**
 * A resolution passes through a claimed state: `approving` while the seats launch, `declining`
 * while a failed launch is cleaned up. The claim is what makes two devices resolving one reopened
 * gate safe: the second finds the row claimed and is refused, so a decline can never retire the
 * Crew an approval is launching. A claim the server lost mid-way is finished or handed back at
 * boot (`reconcile` on CrewProposalService).
 */
export type CrewProposalStatus = "open" | "approving" | "declining" | "approved" | "declined";
export type CrewProposalDecision = "approve" | "decline";
export const CREW_PROPOSAL_STATUSES: ReadonlyArray<CrewProposalStatus> = [
  "open",
  "approving",
  "declining",
  "approved",
  "declined",
];
const claimedStatus = (decision: CrewProposalDecision) =>
  decision === "approve" ? ("approving" as const) : ("declining" as const);
const finalStatus = (decision: CrewProposalDecision) =>
  decision === "approve" ? ("approved" as const) : ("declined" as const);

export interface CrewProposal {
  readonly id: string;
  readonly squadronId: SquadronId;
  readonly captainParticipantId: ParticipantId;
  readonly captainThreadId: ThreadId;
  readonly crewInstanceId: string | null;
  readonly kind: CrewProposalKind;
  readonly status: CrewProposalStatus;
  readonly brief: string;
  readonly displayName: string;
  readonly requestedSeats: ReadonlyArray<CrewProposalSeat>;
  readonly approvedSeats: ReadonlyArray<CrewProposalSeat> | null;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

export interface CreateCrewProposalInput {
  readonly id: string;
  readonly squadronId: SquadronId;
  readonly captainParticipantId: ParticipantId;
  readonly captainThreadId: ThreadId;
  readonly crewInstanceId: string | null;
  readonly kind: CrewProposalKind;
  readonly brief: string;
  readonly displayName: string;
  readonly requestedSeats: ReadonlyArray<CrewProposalSeat>;
  readonly createdAt: string;
}

export interface AgentCrewProposalServiceShape {
  /** Idempotent by proposal id; a retried tool call finds its earlier proposal. */
  readonly create: (input: CreateCrewProposalInput) => Effect.Effect<CrewProposal, SqlError>;
  readonly read: (id: string) => Effect.Effect<CrewProposal | null, SqlError>;
  readonly listOpen: () => Effect.Effect<ReadonlyArray<CrewProposal>, SqlError>;
  readonly listForCaptain: (
    captainParticipantId: ParticipantId,
  ) => Effect.Effect<ReadonlyArray<CrewProposal>, SqlError>;
  /**
   * Claims the open proposal for one resolution, compare-and-set from `open`. Returns the proposal
   * when this call won the claim and null when another resolver already holds or finished it, so
   * two approvals can never both spawn and a decline cannot undo a concurrent approval. An
   * approval records the seats the person approved; a decline leaves them as they were.
   */
  readonly claim: (input: {
    readonly id: string;
    readonly decision: CrewProposalDecision;
    readonly approvedSeats: ReadonlyArray<CrewProposalSeat> | null;
  }) => Effect.Effect<CrewProposal | null, SqlError>;
  /**
   * Writes the final status of a claimed proposal, compare-and-set from its claimed state. Null
   * when the row was not in that state, which means the claim was lost.
   */
  readonly complete: (input: {
    readonly id: string;
    readonly decision: CrewProposalDecision;
    readonly crewInstanceId: string | null;
    readonly resolvedAt: string;
  }) => Effect.Effect<CrewProposal | null, SqlError>;
  /** Hands a claimed proposal back to the gate after its spawn or cleanup failed. */
  readonly reopen: (id: string) => Effect.Effect<CrewProposal | null, SqlError>;
  /** Proposals still claimed: what a crash mid-resolution leaves for the boot sweep. */
  readonly listClaimed: () => Effect.Effect<ReadonlyArray<CrewProposal>, SqlError>;
  /** Records the crew a claimed roster proposal produced. */
  readonly attachInstance: (
    id: string,
    crewInstanceId: string,
  ) => Effect.Effect<CrewProposal | null, SqlError>;
}

export class AgentCrewProposalService extends Context.Service<
  AgentCrewProposalService,
  AgentCrewProposalServiceShape
>()("t3/j5/a2a/AgentCrewProposalService") {}

interface Row {
  readonly id: string;
  readonly squadron_id: string;
  readonly captain_participant_id: string;
  readonly captain_thread_id: string;
  readonly crew_instance_id: string | null;
  readonly kind: string;
  readonly status: string;
  readonly brief: string;
  readonly display_name: string;
  readonly requested_seats: string;
  readonly approved_seats: string | null;
  readonly created_at: string;
  readonly resolved_at: string | null;
}

const fromRow = (row: Row): CrewProposal => ({
  id: row.id,
  squadronId: SquadronId.make(row.squadron_id),
  captainParticipantId: ParticipantId.make(row.captain_participant_id),
  captainThreadId: ThreadId.make(row.captain_thread_id),
  crewInstanceId: row.crew_instance_id,
  kind: row.kind === "addition" ? "addition" : "roster",
  status: CREW_PROPOSAL_STATUSES.find((status) => status === row.status) ?? "open",
  brief: row.brief,
  displayName: row.display_name,
  requestedSeats: decodeSeats(row.requested_seats),
  approvedSeats: row.approved_seats === null ? null : decodeSeats(row.approved_seats),
  createdAt: row.created_at,
  resolvedAt: row.resolved_at,
});

export const layer: Layer.Layer<AgentCrewProposalService, never, SqlClient.SqlClient> =
  Layer.effect(
    AgentCrewProposalService,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const read = Effect.fn("j5.a2a.agentCrewProposals.read")(function* (id: string) {
        const rows = yield* sql<Row>`
          SELECT * FROM j5_agent_crew_proposal WHERE id = ${id} LIMIT 1
        `;
        return rows[0] === undefined ? null : fromRow(rows[0]);
      });

      const create = Effect.fn("j5.a2a.agentCrewProposals.create")(function* (
        input: CreateCrewProposalInput,
      ) {
        yield* sql`
          INSERT OR IGNORE INTO j5_agent_crew_proposal (
            id, squadron_id, captain_participant_id, captain_thread_id, crew_instance_id, kind,
            status, brief, display_name, requested_seats, approved_seats, created_at, resolved_at
          ) VALUES (
            ${input.id}, ${input.squadronId}, ${input.captainParticipantId},
            ${input.captainThreadId}, ${input.crewInstanceId}, ${input.kind}, 'open',
            ${input.brief}, ${input.displayName}, ${encodeSeats(input.requestedSeats)}, NULL,
            ${input.createdAt}, NULL
          )
        `;
        return (yield* read(input.id))!;
      });

      const listOpen = Effect.fn("j5.a2a.agentCrewProposals.listOpen")(function* () {
        const rows = yield* sql<Row>`
          SELECT * FROM j5_agent_crew_proposal WHERE status = 'open' ORDER BY created_at, id
        `;
        return rows.map(fromRow);
      });

      const listForCaptain = Effect.fn("j5.a2a.agentCrewProposals.listForCaptain")(function* (
        captainParticipantId: ParticipantId,
      ) {
        const rows = yield* sql<Row>`
          SELECT * FROM j5_agent_crew_proposal
          WHERE captain_participant_id = ${captainParticipantId}
          ORDER BY created_at, id
        `;
        return rows.map(fromRow);
      });

      const claim = Effect.fn("j5.a2a.agentCrewProposals.claim")(function* (input: {
        readonly id: string;
        readonly decision: CrewProposalDecision;
        readonly approvedSeats: ReadonlyArray<CrewProposalSeat> | null;
      }) {
        const claimed = yield* sql<{ readonly id: string }>`
          UPDATE j5_agent_crew_proposal
          SET status = ${claimedStatus(input.decision)},
              approved_seats = COALESCE(${input.approvedSeats === null ? null : encodeSeats(input.approvedSeats)}, approved_seats)
          WHERE id = ${input.id} AND status = 'open'
          RETURNING id
        `;
        return claimed.length === 0 ? null : yield* read(input.id);
      });

      // A declined proposal keeps its Crew id (the retired record stays readable) and drops the
      // approved seats, which belonged to the approval that never was.
      const complete = Effect.fn("j5.a2a.agentCrewProposals.complete")(function* (input: {
        readonly id: string;
        readonly decision: CrewProposalDecision;
        readonly crewInstanceId: string | null;
        readonly resolvedAt: string;
      }) {
        const done = yield* sql<{ readonly id: string }>`
          UPDATE j5_agent_crew_proposal
          SET status = ${finalStatus(input.decision)},
              approved_seats = CASE WHEN ${input.decision === "approve" ? 1 : 0} = 1 THEN approved_seats ELSE NULL END,
              crew_instance_id = COALESCE(${input.crewInstanceId}, crew_instance_id),
              resolved_at = ${input.resolvedAt}
          WHERE id = ${input.id} AND status = ${claimedStatus(input.decision)}
          RETURNING id
        `;
        return done.length === 0 ? null : yield* read(input.id);
      });

      // The approved seats stay: they are the roster the human edited, and the card reseeds
      // from them so a failed launch does not cost the person their edits.
      const reopen = Effect.fn("j5.a2a.agentCrewProposals.reopen")(function* (id: string) {
        yield* sql`
          UPDATE j5_agent_crew_proposal
          SET status = 'open', resolved_at = NULL
          WHERE id = ${id} AND status IN ('approving', 'declining')
        `;
        return yield* read(id);
      });

      const listClaimed = Effect.fn("j5.a2a.agentCrewProposals.listClaimed")(function* () {
        const rows = yield* sql<Row>`
          SELECT * FROM j5_agent_crew_proposal
          WHERE status IN ('approving', 'declining')
          ORDER BY created_at, id
        `;
        return rows.map(fromRow);
      });

      const attachInstance = Effect.fn("j5.a2a.agentCrewProposals.attachInstance")(function* (
        id: string,
        crewInstanceId: string,
      ) {
        yield* sql`
          UPDATE j5_agent_crew_proposal SET crew_instance_id = ${crewInstanceId} WHERE id = ${id}
        `;
        return yield* read(id);
      });

      return AgentCrewProposalService.of({
        create,
        read,
        listOpen,
        listForCaptain,
        claim,
        complete,
        reopen,
        listClaimed,
        attachInstance,
      });
    }),
  );
