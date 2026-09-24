import type { StoredCommEvent } from "./contracts.ts";
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
  type ClearOwnAskInput,
  type ClearOwnAskResult,
  CommCommandId,
  type CommEvent,
  CorrelationId,
  SquadronId,
  ExchangeId,
  isHumanParticipantId,
  isMachineParticipantId,
  LedgerMessageId,
  MessageSentPayload,
  LIFECYCLE_PARTICIPANT_ID,
  Participant,
  type ParticipantDirectoryRow,
  ParticipantId,
  type SendAsMachineInput,
  type SendMessageInput,
  type SendMessageResult,
  participantId,
} from "./contracts.ts";
import { resolveThreadHome } from "./HomeRegistrar.ts";
import { isRegisteredHumanPerson, listRegisteredHumanPersonIds } from "./HumanPersonRegistry.ts";
import { A2ALedgerTransactionWriter, A2ALedger, type A2ALedgerError } from "./LedgerService.ts";
import { PeerDirectory, type PeerDirectoryError } from "./PeerDirectory.ts";
import { findPeerCounterparty, findPeerRoute } from "./peerCounterparty.ts";

const encodeSentPayload = Schema.encodeEffect(Schema.toCodecJson(MessageSentPayload));

export class A2ASenderNotJoinedError extends Schema.TaggedError<A2ASenderNotJoinedError>()(
  "A2ASenderNotJoinedError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Cross-agent messaging is unavailable for native thread ${this.threadId} because it has no registered home squadron. Call list_squadrons to find the Squadron that references this thread's project, then join_squadron with that exact squadron_id. Until that succeeds, stop this messaging attempt.`;
  }
}

export class A2AHomeMembershipStateError extends Schema.TaggedError<A2AHomeMembershipStateError>()(
  "A2AHomeMembershipStateError",
  {
    threadId: Schema.String,
    expectedSquadronId: Schema.String,
    expectedParticipantId: Schema.String,
    activeHomes: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const active = this.activeHomes.length === 0 ? "none" : this.activeHomes.join(", ");
    return `Thread ${this.threadId} has immutable home ${this.expectedSquadronId}:${this.expectedParticipantId}, but its active membership projection is ${active}. Repair the projection before retrying; do not register a new home.`;
  }
}

export class A2ASenderRetiredError extends Schema.TaggedError<A2ASenderRetiredError>()(
  "A2ASenderRetiredError",
  {
    threadId: Schema.String,
    squadronId: Schema.String,
    participantId: Schema.String,
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} was retired from immutable home ${this.squadronId}:${this.participantId} by participant.left and cannot send cross-agent messages. Do not repair the projection or register another home; stop this messaging attempt.`;
  }
}

export class A2AParticipantNotFoundError extends Schema.TaggedError<A2AParticipantNotFoundError>()(
  "A2AParticipantNotFoundError",
  { participantId: Schema.String },
) {
  override get message(): string {
    return `Participant ${this.participantId} is not currently reachable. Call list_participants and choose an agent row with canReceiveMessage=true, or a human row with canOpenExchange=true to open an ask.`;
  }
}

export class A2AAmbiguousParticipantError extends Schema.TaggedError<A2AAmbiguousParticipantError>()(
  "A2AAmbiguousParticipantError",
  { participantId: Schema.String },
) {
  override get message(): string {
    return `Participant ${this.participantId} is active in more than one squadron and cannot be addressed unambiguously. Call list_participants and choose a participantId with canReceiveMessage=true, or ask the human to repair squadron membership.`;
  }
}

/** Names no server: which peers exist and why one is unreachable are facts for the person's surfaces. */
export class A2APeersUnreadError extends Schema.TaggedError<A2APeersUnreadError>()(
  "A2APeersUnreadError",
  { participantId: Schema.String, unreadPeerCount: Schema.Number },
) {
  override get message(): string {
    return `Participant ${this.participantId} is not homed on this server and has never been seen here, and ${String(this.unreadPeerCount)} peer server(s) could not be read just now. Retry shortly; list_participants reports how many peers are currently unread.`;
  }
}

export class A2AParticipantArchivedError extends Schema.TaggedError<A2AParticipantArchivedError>()(
  "A2AParticipantArchivedError",
  {
    participantId: Schema.String,
    squadronId: Schema.String,
  },
) {
  override get message(): string {
    return `Participant ${this.participantId} is archived or permanently retired from home ${this.squadronId} and cannot send or receive messages. Choose an active participant. Unarchive restores only reversibly archived identities.`;
  }
}

export class A2AIntentRequiredError extends Schema.TaggedError<A2AIntentRequiredError>()(
  "A2AIntentRequiredError",
  {},
) {
  override get message(): string {
    return "Opening an exchange requires intent. Retry send_message with a one-line intent summary.";
  }
}

export class A2AUrgencyRequiredError extends Schema.TaggedError<A2AUrgencyRequiredError>()(
  "A2AUrgencyRequiredError",
  {},
) {
  override get message(): string {
    return "Opening an exchange to the human requires urgency=blocking|soon|fyi. Retry send_message with urgency.";
  }
}

export class A2AUrgencyNotAcceptedError extends Schema.TaggedError<A2AUrgencyNotAcceptedError>()(
  "A2AUrgencyNotAcceptedError",
  { participantId: Schema.String },
) {
  override get message(): string {
    return `Participant ${this.participantId} does not accept urgency. Retry send_message without urgency.`;
  }
}

export class A2AUrgencyRequiresExchangeError extends Schema.TaggedError<A2AUrgencyRequiresExchangeError>()(
  "A2AUrgencyRequiresExchangeError",
  {},
) {
  override get message(): string {
    return "Urgency applies only when opening a reply-expected exchange to the human. Retry without urgency, or set expect_reply=true with intent and urgency.";
  }
}

export class A2AHumanAskOrReplyRequiredError extends Schema.TaggedError<A2AHumanAskOrReplyRequiredError>()(
  "A2AHumanAskOrReplyRequiredError",
  { participantId: Schema.String },
) {
  override get message(): string {
    return `A plain send to human participant ${this.participantId} is refused. To the human, use an ask with expect_reply=true, intent, and urgency=blocking|soon|fyi, or a reply with exchange_id. If nobody needs to act, say it in your own thread instead.`;
  }
}

export class A2AHumanFollowupNotAllowedError extends Schema.TaggedError<A2AHumanFollowupNotAllowedError>()(
  "A2AHumanFollowupNotAllowedError",
  { participantId: Schema.String },
) {
  override get message(): string {
    return `A follow-up to human participant ${this.participantId} is refused. To the human, use an ask with expect_reply=true, intent, and urgency=blocking|soon|fyi, or a reply with exchange_id; after an ask is open, wait for its reply, or clear_own_ask on the open exchange and re-ask with the combined content. If nobody needs to act, say it in your own thread instead.`;
  }
}

export class A2AExchangeNotOpenError extends Schema.TaggedError<A2AExchangeNotOpenError>()(
  "A2AExchangeNotOpenError",
  { exchangeId: Schema.String },
) {
  override get message(): string {
    return `Exchange ${this.exchangeId} is not open. Call send_message without exchange_id to start a new message or exchange.`;
  }
}

export class A2AExchangeParticipantMismatchError extends Schema.TaggedError<A2AExchangeParticipantMismatchError>()(
  "A2AExchangeParticipantMismatchError",
  {
    exchangeId: Schema.String,
    senderId: Schema.String,
    receiverId: Schema.String,
  },
) {
  override get message(): string {
    return `Exchange ${this.exchangeId} does not connect ${this.senderId} to ${this.receiverId}. Call list_participants and use the exchange's original peer.`;
  }
}

export class A2AExchangeAlreadyAnsweredError extends Schema.TaggedError<A2AExchangeAlreadyAnsweredError>()(
  "A2AExchangeAlreadyAnsweredError",
  { exchangeId: Schema.String },
) {
  override get message(): string {
    return `Exchange ${this.exchangeId} already has its one durable reply and is closing or closed. Call send_message without exchange_id to start a new message or exchange.`;
  }
}

export class A2ACrossSquadronReplyInvariantError extends Schema.TaggedError<A2ACrossSquadronReplyInvariantError>()(
  "A2ACrossSquadronReplyInvariantError",
  {
    exchangeId: Schema.String,
    exchangeSquadronId: Schema.String,
    senderSquadronId: Schema.String,
    replyPersisted: Schema.Boolean,
  },
) {
  override get message(): string {
    const replyState = this.replyPersisted
      ? "A durable reply is already persisted for this command under the cross-Squadron state; this replay sent nothing new."
      : "A cross-Squadron reply cannot record the required closure fact, so nothing was sent.";
    return `Exchange ${this.exchangeId} belongs to ${this.exchangeSquadronId}, but the replying sender's immutable home is ${this.senderSquadronId}. ${replyState} Report this invariant failure with the exchange and Squadron ids; do not retry send_message for this exchange.`;
  }
}

export class A2AClearOwnAskSenderMismatchError extends Schema.TaggedError<A2AClearOwnAskSenderMismatchError>()(
  "A2AClearOwnAskSenderMismatchError",
  {
    exchangeId: Schema.String,
    callerId: Schema.String,
    senderId: Schema.String,
  },
) {
  override get message(): string {
    return `Exchange ${this.exchangeId} was opened by ${this.senderId}, not ${this.callerId}. Only that sender may withdraw this exchange. Do not retry clear_own_ask for exchange ${this.exchangeId} from this thread; other exchanges are unaffected.`;
  }
}

export class A2AClearOwnAskAlreadyClosedError extends Schema.TaggedError<A2AClearOwnAskAlreadyClosedError>()(
  "A2AClearOwnAskAlreadyClosedError",
  { exchangeId: Schema.String },
) {
  override get message(): string {
    return `Exchange ${this.exchangeId} is already closed; clear_own_ask made no change.`;
  }
}

export class A2AClearOwnAskUnknownExchangeError extends Schema.TaggedError<A2AClearOwnAskUnknownExchangeError>()(
  "A2AClearOwnAskUnknownExchangeError",
  { exchangeId: Schema.String },
) {
  override get message(): string {
    return `Exchange ${this.exchangeId} does not exist in the messaging ledger; clear_own_ask made no change. There is no agent-facing own-open-asks read at this head, so use only an exchange_id retained from the original send_message result; do not retry this unknown id.`;
  }
}

export class A2AClearOwnAskCommandConflictError extends Schema.TaggedError<A2AClearOwnAskCommandConflictError>()(
  "A2AClearOwnAskCommandConflictError",
  { commandId: Schema.String, exchangeId: Schema.String },
) {
  override get message(): string {
    return `The client_request_id behind command ${this.commandId} is already bound to a different request. This clear_own_ask call did not close exchange ${this.exchangeId}. Reusing a client_request_id for the same clear replays its original success; retry this different request with a unique client_request_id.`;
  }
}

export class A2AMachineCannotReceiveError extends Schema.TaggedError<A2AMachineCannotReceiveError>()(
  "A2AMachineCannotReceiveError",
  { participantId: Schema.String },
) {
  override get message(): string {
    return `Participant ${this.participantId} is an automated sender with no thread and cannot receive messages. Call list_participants and choose a row with canReceiveMessage=true.`;
  }
}

export class A2AMachineSenderNotRegisteredError extends Schema.TaggedError<A2AMachineSenderNotRegisteredError>()(
  "A2AMachineSenderNotRegisteredError",
  { participantId: Schema.String },
) {
  override get message(): string {
    return `Machine participant ${this.participantId} is not registered in any Squadron. Register it with \`j5 a2a participant create\` before sending.`;
  }
}

export type A2ASendError =
  | A2ALedgerError
  | Schema.SchemaError
  | SqlError
  | PeerDirectoryError
  | A2AMachineCannotReceiveError
  | A2AMachineSenderNotRegisteredError
  | A2ASenderNotJoinedError
  | A2ASenderRetiredError
  | A2AHomeMembershipStateError
  | A2AParticipantNotFoundError
  | A2AAmbiguousParticipantError
  | A2APeersUnreadError
  | A2AParticipantArchivedError
  | A2AIntentRequiredError
  | A2AUrgencyRequiredError
  | A2AUrgencyNotAcceptedError
  | A2AUrgencyRequiresExchangeError
  | A2AHumanAskOrReplyRequiredError
  | A2AHumanFollowupNotAllowedError
  | A2AExchangeNotOpenError
  | A2AExchangeAlreadyAnsweredError
  | A2ACrossSquadronReplyInvariantError
  | A2AExchangeParticipantMismatchError
  | A2AClearOwnAskSenderMismatchError
  | A2AClearOwnAskAlreadyClosedError
  | A2AClearOwnAskUnknownExchangeError
  | A2AClearOwnAskCommandConflictError;

interface MembershipRow {
  readonly squadron_id: string;
  readonly participant_id: string;
  readonly payload: string;
  readonly archived_at: string | null;
}

interface RetiredParticipantRow {
  readonly squadron_id: string;
}

interface MachineRow {
  readonly participant_id: string;
  readonly squadron_id: string;
  readonly name: string;
}

interface ExchangeRow {
  readonly squadron_id: string;
  readonly exchange_id: string;
  readonly sender_id: string;
  readonly receiver_id: string;
  readonly status: "open" | "closed" | "dropped";
}

interface ExistingMessageRow {
  readonly squadron_id: string;
  readonly sender_id: string;
  readonly receiver_id: string;
  readonly exchange_id: string | null;
  readonly exchange_role: "none" | "ask" | "followup" | "reply" | "terminal_notice";
  readonly sent_seq: number;
}

interface ExistingSenderClearedRow {
  readonly created_at: string;
  readonly closure_kind: string | null;
}

const decodeParticipant = Schema.decodeUnknownEffect(Schema.fromJsonString(Participant));

const messageIdFor = (commandId: CommCommandId) =>
  LedgerMessageId.make(`message:j5:a2a:${encodeURIComponent(commandId)}`);

const exchangeIdFor = (commandId: CommCommandId) =>
  ExchangeId.make(`exchange:j5:a2a:${encodeURIComponent(commandId)}`);

const correlationIdFor = (commandId: CommCommandId) =>
  CorrelationId.make(`correlation:j5:a2a:${encodeURIComponent(commandId)}`);

const withdrawalMessageIdFor = (commandId: CommCommandId) =>
  LedgerMessageId.make(`message:j5:a2a:withdraw:${encodeURIComponent(commandId)}`);

/** Platform-authored, like the retirement notice: the asker cleared its own ask, nothing is owed. */
export const formatWithdrawalNotice = (input: {
  readonly exchangeId: ExchangeId;
  readonly askerId: ParticipantId;
}): string =>
  [
    "[Cross-agent messaging system notice: exchange withdrawn]",
    `Exchange ${input.exchangeId} was withdrawn by ${input.askerId}, who no longer needs an answer.`,
    "Your reply obligation has ended; do not reply to this Exchange.",
    "This is a platform-authored terminal notice, not a peer reply.",
  ].join("\n\n");

interface ResolvedSender {
  readonly squadronId: SquadronId;
  readonly participantId: ParticipantId;
}

/** Where a receiver lives; `environmentId` names a peer server, null means this one. */
interface ResolvedReceiver {
  readonly squadronId: SquadronId;
  readonly participantId: ParticipantId;
  readonly kind: Participant["kind"];
  readonly environmentId: string | null;
}

/** What the tool reports, plus whether a withdrawal now waits for the delivery worker. Agents never see the flag. */
export interface ClearOwnAskOutcome extends ClearOwnAskResult {
  readonly withdrawalQueued: boolean;
}

/** The send body once the sender is resolved; agents and machines share it. */
type ResolvedSendInput = Omit<SendMessageInput, "senderThreadId">;

export interface A2ASendServiceShape {
  readonly send: (input: SendMessageInput) => Effect.Effect<SendMessageResult, A2ASendError>;
  /** A registered machine participant commits a plain message through the same path an agent uses. */
  readonly sendAsMachine: (
    input: SendAsMachineInput,
  ) => Effect.Effect<SendMessageResult, A2ASendError>;
  readonly clearOwnAsk: (
    input: ClearOwnAskInput,
  ) => Effect.Effect<ClearOwnAskOutcome, A2ASendError>;
  readonly listParticipants: (
    senderThreadId: ThreadId,
    includeArchived?: boolean,
  ) => Effect.Effect<ReadonlyArray<ParticipantDirectoryRow>, A2ASendError>;
}

export class A2ASendService extends Context.Service<A2ASendService, A2ASendServiceShape>()(
  "t3/j5/a2a/SendService/A2ASendService",
) {}

type A2ASendServiceLayerDependencies =
  | A2ALedger
  | A2ALedgerTransactionWriter
  | SqlClient.SqlClient
  | PeerDirectory;

export const layer: Layer.Layer<A2ASendService, never, A2ASendServiceLayerDependencies> =
  Layer.effect(
    A2ASendService,
    Effect.gen(function* () {
      const ledger = yield* A2ALedger;
      const writer = yield* A2ALedgerTransactionWriter;
      const sql = yield* SqlClient.SqlClient;
      const peers = yield* PeerDirectory;

      const membershipRows = Effect.fn("j5.a2a.send.membershipRows")(function* () {
        return yield* sql<MembershipRow>`
          SELECT squadron_id, participant_id, payload, archived_at
          FROM j5_a2a_squadron_membership
          ORDER BY squadron_id, participant_id
        `;
      });

      const retiredParticipantRows = Effect.fn("j5.a2a.send.retiredParticipantRows")(function* (
        id: ParticipantId,
      ) {
        return yield* sql<RetiredParticipantRow>`
          SELECT joined.squadron_id
          FROM j5_a2a_comm_event AS joined
          WHERE joined.kind = 'participant.joined'
            AND json_extract(joined.payload, '$.participant.kind') = 'agent'
            AND json_extract(joined.payload, '$.participant.id') = ${id}
            AND EXISTS (
              SELECT 1
              FROM j5_a2a_comm_event AS retirement
              WHERE retirement.squadron_id = joined.squadron_id
                AND retirement.seq > joined.seq
                AND retirement.kind IN ('participant.left', 'participant.deleted')
                AND json_extract(retirement.payload, '$.participant.kind') = 'agent'
                AND json_extract(retirement.payload, '$.participant.id') = ${id}
                AND json_extract(retirement.payload, '$.participant.threadId') =
                  json_extract(joined.payload, '$.participant.threadId')
            )
          ORDER BY joined.seq
          LIMIT 2
        `;
      });

      const senderMembership = Effect.fn("j5.a2a.send.senderMembership")(function* (
        threadId: ThreadId,
      ) {
        const resolution = yield* resolveThreadHome(sql, threadId).pipe(
          Effect.catchTag("A2AHomeNotFoundError", () =>
            Effect.fail(new A2ASenderNotJoinedError({ threadId })),
          ),
        );
        const matches = resolution.activeMemberships.filter(
          (membership) =>
            membership.squadronId === resolution.home.squadronId &&
            membership.participantId === resolution.home.participantId,
        );
        if (resolution.retired && resolution.activeMemberships.length === 0) {
          return yield* new A2ASenderRetiredError({
            threadId,
            squadronId: resolution.home.squadronId,
            participantId: resolution.home.participantId,
          });
        }
        if (
          resolution.retired ||
          resolution.activeMemberships.length !== 1 ||
          matches.length !== 1
        ) {
          return yield* new A2AHomeMembershipStateError({
            threadId,
            expectedSquadronId: resolution.home.squadronId,
            expectedParticipantId: resolution.home.participantId,
            activeHomes: resolution.activeMemberships.map(
              (membership) => `${membership.squadronId}:${membership.participantId}`,
            ),
          });
        }
        const membership = (yield* sql<{
          readonly archived_at: string | null;
        }>`SELECT archived_at FROM j5_a2a_squadron_membership WHERE participant_id = ${resolution.home.participantId}`)[0];
        if (membership?.archived_at != null) {
          return yield* new A2AParticipantArchivedError({
            participantId: resolution.home.participantId,
            squadronId: resolution.home.squadronId,
          });
        }
        return resolution.home;
      });

      const machineRows = Effect.fn("j5.a2a.send.machineRows")(function* (id?: ParticipantId) {
        return yield* id === undefined
          ? sql<MachineRow>`
              SELECT participant_id, squadron_id, name
              FROM j5_a2a_machine_participant
              ORDER BY squadron_id, participant_id
            `
          : sql<MachineRow>`
              SELECT participant_id, squadron_id, name
              FROM j5_a2a_machine_participant
              WHERE participant_id = ${id}
              LIMIT 1
            `;
      });

      const machineSender = Effect.fn("j5.a2a.send.machineSender")(function* (
        id: ParticipantId,
      ): Effect.fn.Return<ResolvedSender, A2AMachineSenderNotRegisteredError | SqlError> {
        const row = (yield* machineRows(id))[0];
        if (row === undefined) {
          return yield* new A2AMachineSenderNotRegisteredError({ participantId: id });
        }
        return { squadronId: SquadronId.make(row.squadron_id), participantId: id };
      });

      /**
       * The route the ledger already recorded for a remote agent: the ask that
       * reached it or the ask it sent here. It lets a send to a known participant
       * be recorded and retried while that peer is asleep, as the definition asks.
       */
      const recordedRoute = Effect.fn("j5.a2a.send.recordedRoute")(function* (
        id: ParticipantId,
      ): Effect.fn.Return<ResolvedReceiver | null, SqlError> {
        const route = yield* findPeerRoute(sql, id);
        return route === null ? null : { participantId: id, kind: "agent", ...route };
      });

      /**
       * A receiver no local Squadron homes may be an agent on a peer server. The
       * platform resolves it through the peers' address books; the sender named a
       * participant, never a server. Runs outside the ledger transaction: it is
       * a network read, and the transaction re-checks the local facts afterwards.
       */
      const remoteMembership = Effect.fn("j5.a2a.send.remoteMembership")(function* (
        id: ParticipantId,
      ): Effect.fn.Return<
        ResolvedReceiver,
        | SqlError
        | PeerDirectoryError
        | A2AParticipantNotFoundError
        | A2AAmbiguousParticipantError
        | A2APeersUnreadError
        | A2AParticipantArchivedError
      > {
        // A participant this server has already exchanged messages with keeps
        // its recorded route; only an unknown id fans out to every peer's roster,
        // so one dead peer never taxes a send to a known one.
        const known = yield* recordedRoute(id);
        if (known !== null) return known;
        const reading = yield* peers.resolveAgent(id);
        const active = reading.agents.filter((agent) => !agent.archived);
        if (active.length > 1)
          return yield* new A2AAmbiguousParticipantError({ participantId: id });
        const agent = active[0] ?? reading.agents[0];
        if (agent === undefined) {
          if (reading.unreadPeers.length === 0) {
            return yield* new A2AParticipantNotFoundError({ participantId: id });
          }
          return yield* new A2APeersUnreadError({
            participantId: id,
            unreadPeerCount: reading.unreadPeers.length,
          });
        }
        if (agent.archived) {
          return yield* new A2AParticipantArchivedError({
            participantId: id,
            squadronId: agent.squadronId,
          });
        }
        return {
          squadronId: agent.squadronId,
          participantId: id,
          kind: "agent",
          environmentId: agent.environmentId,
        };
      });

      /** Local agent ids only; people and machines are never on a peer, and a known local agent needs no lookup. */
      const needsRemoteResolution = Effect.fn("j5.a2a.send.needsRemoteResolution")(function* (
        id: ParticipantId,
      ) {
        if (isHumanParticipantId(id) || isMachineParticipantId(id)) return false;
        const local = yield* sql<{ readonly one: number }>`
          SELECT 1 AS one FROM j5_a2a_squadron_membership WHERE participant_id = ${id} LIMIT 1
        `;
        if (local[0] !== undefined) return false;
        return (yield* retiredParticipantRows(id)).length === 0;
      });

      /** The network half of resolution, done before the transaction opens. */
      const preResolveRemote = Effect.fn("j5.a2a.send.preResolveRemote")(function* (
        id: ParticipantId,
      ) {
        return (yield* needsRemoteResolution(id)) ? yield* remoteMembership(id) : null;
      });

      const participantMembership = Effect.fn("j5.a2a.send.participantMembership")(function* (
        id: ParticipantId,
        senderSquadronId: SquadronId,
        remote: ResolvedReceiver | null,
      ): Effect.fn.Return<
        ResolvedReceiver,
        | SqlError
        | Schema.SchemaError
        | A2AParticipantNotFoundError
        | A2AAmbiguousParticipantError
        | A2AParticipantArchivedError
        | A2AMachineCannotReceiveError
      > {
        if (isHumanParticipantId(id)) {
          if (!(yield* isRegisteredHumanPerson(sql, id))) {
            return yield* new A2AParticipantNotFoundError({ participantId: id });
          }
          return {
            squadronId: senderSquadronId,
            participantId: id,
            kind: "human",
            environmentId: null,
          };
        }
        if (isMachineParticipantId(id)) {
          const machine = yield* machineRows(id);
          return machine[0] === undefined
            ? yield* new A2AParticipantNotFoundError({ participantId: id })
            : yield* new A2AMachineCannotReceiveError({ participantId: id });
        }
        const matches = (yield* membershipRows()).filter((row) => row.participant_id === id);
        if (matches.length === 0) {
          const retired = yield* retiredParticipantRows(id);
          if (retired[0] === undefined) {
            if (remote !== null) return remote;
            return yield* new A2AParticipantNotFoundError({ participantId: id });
          }
          if (retired.length > 1) {
            return yield* new A2AAmbiguousParticipantError({ participantId: id });
          }
          return yield* new A2AParticipantArchivedError({
            participantId: id,
            squadronId: retired[0].squadron_id,
          });
        }
        if (matches.length > 1) {
          return yield* new A2AAmbiguousParticipantError({ participantId: id });
        }
        if (matches[0]!.archived_at !== null) {
          return yield* new A2AParticipantArchivedError({
            participantId: id,
            squadronId: matches[0]!.squadron_id,
          });
        }
        const participant = yield* decodeParticipant(matches[0]!.payload);
        return {
          squadronId: SquadronId.make(matches[0]!.squadron_id),
          participantId: id,
          kind: participant.kind,
          environmentId: null,
        };
      });

      const listParticipants: A2ASendServiceShape["listParticipants"] = (
        senderThreadId,
        includeArchived = false,
      ) =>
        Effect.gen(function* () {
          const sender = yield* senderMembership(senderThreadId);
          const rows = yield* membershipRows();
          const people = yield* listRegisteredHumanPersonIds(sql);
          const membershipCounts = new Map<string, number>();
          for (const row of rows) {
            membershipCounts.set(
              row.participant_id,
              (membershipCounts.get(row.participant_id) ?? 0) + 1,
            );
          }
          const agents = yield* Effect.forEach(
            rows.filter((row) => includeArchived || row.archived_at === null),
            (row) =>
              decodeParticipant(row.payload).pipe(
                Effect.map((participant) => {
                  const id = participantId(participant);
                  const addressable = membershipCounts.get(id) === 1 && row.archived_at === null;
                  return {
                    squadronId: SquadronId.make(row.squadron_id),
                    participantId: id,
                    participant,
                    archived: row.archived_at !== null,
                    canReceiveMessage: addressable,
                    canOpenExchange: addressable,
                    acceptsUrgency: false,
                  };
                }),
              ),
            { concurrency: 1 },
          );
          return [
            ...agents,
            ...people.map(
              (personId) =>
                ({
                  squadronId: sender.squadronId,
                  participantId: personId,
                  participant: { kind: "human", id: personId },
                  archived: false,
                  canReceiveMessage: false,
                  canOpenExchange: true,
                  acceptsUrgency: true,
                }) satisfies ParticipantDirectoryRow,
            ),
            // Machines are listed so an agent can recognize a sender by name; nothing reaches them.
            ...(yield* machineRows()).map(
              (row) =>
                ({
                  squadronId: SquadronId.make(row.squadron_id),
                  participantId: ParticipantId.make(row.participant_id),
                  participant: {
                    kind: "machine",
                    id: ParticipantId.make(row.participant_id),
                    name: row.name,
                  },
                  archived: false,
                  canReceiveMessage: false,
                  canOpenExchange: false,
                  acceptsUrgency: false,
                }) satisfies ParticipantDirectoryRow,
            ),
          ];
        });

      const replayedSend = Effect.fn("j5.a2a.send.replayedSend")(function* (
        messageId: LedgerMessageId,
        senderId: ParticipantId,
      ) {
        const rows = yield* sql<ExistingMessageRow>`
          SELECT
            squadron_id,
            sender_id,
            receiver_id,
            exchange_id,
            exchange_role,
            sent_seq
          FROM j5_a2a_delivery
          WHERE message_id = ${messageId}
            AND sender_id = ${senderId}
          LIMIT 2
        `;
        if (rows.length !== 1) return null;
        const row = rows[0]!;
        const exchange =
          row.exchange_id === null
            ? []
            : yield* sql<ExchangeRow>`
                SELECT squadron_id, exchange_id, sender_id, receiver_id, status
                FROM j5_a2a_exchange
                WHERE exchange_id = ${row.exchange_id}
                LIMIT 1
              `;
        const isCrossSquadronReply =
          exchange[0] !== undefined &&
          exchange[0].squadron_id !== row.squadron_id &&
          exchange[0].receiver_id === row.sender_id &&
          exchange[0].sender_id === row.receiver_id;
        if (isCrossSquadronReply) {
          return yield* new A2ACrossSquadronReplyInvariantError({
            exchangeId: row.exchange_id!,
            exchangeSquadronId: exchange[0]!.squadron_id,
            senderSquadronId: row.squadron_id,
            replyPersisted: true,
          });
        }
        return {
          messageId,
          exchangeId: row.exchange_id === null ? null : ExchangeId.make(row.exchange_id),
          exchangeState:
            row.exchange_role === "none"
              ? ("none" as const)
              : row.exchange_role !== "reply"
                ? ("open" as const)
                : ("closed" as const),
          joinedExistingExchange: row.exchange_role === "followup",
          durableAtSeq: row.sent_seq,
        } satisfies SendMessageResult;
      });

      const sendInternal = Effect.fn("j5.a2a.send.inTransaction")(function* (
        input: ResolvedSendInput,
        sender: ResolvedSender,
        committed: Array<StoredCommEvent>,
        remote: ResolvedReceiver | null,
      ) {
        const messageId = messageIdFor(input.commandId);
        const replay = yield* replayedSend(messageId, sender.participantId);
        if (replay !== null) return replay;

        const receiver = yield* participantMembership(input.to, sender.squadronId, remote);
        const receiverId = receiver.participantId;
        if (
          receiver.kind === "human" &&
          input.expectReply !== true &&
          input.exchangeId === undefined
        ) {
          return yield* new A2AHumanAskOrReplyRequiredError({ participantId: receiverId });
        }
        let exchangeId: ExchangeId | null = null;
        let exchangeState: SendMessageResult["exchangeState"] = "none";
        let exchangeRole: "none" | "ask" | "followup" | "reply" = "none";
        let joinedExistingExchange = false;
        let openEvent: CommEvent | undefined;
        let closeEvent: CommEvent | undefined;

        if (input.exchangeId !== undefined) {
          if (input.urgency !== undefined) {
            return yield* new A2AUrgencyRequiresExchangeError();
          }
          const rows = yield* sql<ExchangeRow>`
              SELECT squadron_id, exchange_id, sender_id, receiver_id, status
              FROM j5_a2a_exchange
              WHERE exchange_id = ${input.exchangeId}
              LIMIT 2
            `;
          const exchange = rows.length === 1 ? rows[0] : undefined;
          if (exchange === undefined || exchange.status !== "open") {
            return yield* new A2AExchangeNotOpenError({ exchangeId: input.exchangeId });
          }
          const isFollowup =
            exchange.sender_id === sender.participantId && exchange.receiver_id === receiverId;
          const isReply =
            exchange.receiver_id === sender.participantId && exchange.sender_id === receiverId;
          if (!isFollowup && !isReply) {
            return yield* new A2AExchangeParticipantMismatchError({
              exchangeId: input.exchangeId,
              senderId: sender.participantId,
              receiverId,
            });
          }
          exchangeId = input.exchangeId;
          joinedExistingExchange = isFollowup;
          if (isReply) {
            if (exchange.squadron_id !== sender.squadronId) {
              return yield* new A2ACrossSquadronReplyInvariantError({
                exchangeId,
                exchangeSquadronId: exchange.squadron_id,
                senderSquadronId: sender.squadronId,
                replyPersisted: false,
              });
            }
            const acceptedReplies = yield* sql<{ readonly count: number }>`
                SELECT COUNT(*) AS count
                FROM j5_a2a_delivery
                WHERE exchange_id = ${exchangeId} AND exchange_role = 'reply'
              `;
            if ((acceptedReplies[0]?.count ?? 0) > 0) {
              return yield* new A2AExchangeAlreadyAnsweredError({ exchangeId });
            }
            exchangeRole = "reply";
            exchangeState = "closed";
            closeEvent = {
              kind: "exchange.closed",
              sender: sender.participantId,
              receiver: receiverId,
              exchangeId,
              correlationId: correlationIdFor(input.commandId),
              payload: { replyMessageId: messageId },
              createdAt: input.acceptedAt,
            };
          } else {
            exchangeRole = "followup";
            exchangeState = "open";
          }
        } else if (input.expectReply === true) {
          const existing = yield* sql<ExchangeRow>`
              SELECT squadron_id, exchange_id, sender_id, receiver_id, status
              FROM j5_a2a_exchange
              WHERE squadron_id = ${sender.squadronId}
                AND sender_id = ${sender.participantId}
                AND receiver_id = ${receiverId}
                AND status = 'open'
              LIMIT 1
            `;
          if (existing[0] !== undefined) {
            exchangeId = ExchangeId.make(existing[0].exchange_id);
            joinedExistingExchange = true;
            exchangeRole = "followup";
          } else {
            if (input.intent === undefined) return yield* new A2AIntentRequiredError();
            if (receiver.kind === "human" && input.urgency === undefined) {
              return yield* new A2AUrgencyRequiredError();
            }
            if (receiver.kind !== "human" && input.urgency !== undefined) {
              return yield* new A2AUrgencyNotAcceptedError({ participantId: receiverId });
            }
            exchangeId = exchangeIdFor(input.commandId);
            exchangeRole = "ask";
            openEvent = {
              kind: "exchange.opened",
              sender: sender.participantId,
              receiver: receiverId,
              exchangeId,
              correlationId: correlationIdFor(input.commandId),
              payload: {
                intent: input.intent,
                urgency: input.urgency ?? null,
              },
              createdAt: input.acceptedAt,
            };
          }
          exchangeState = "open";
        } else if (input.urgency !== undefined) {
          return yield* new A2AUrgencyRequiresExchangeError();
        }

        if (receiver.kind === "human" && exchangeRole === "followup") {
          return yield* new A2AHumanFollowupNotAllowedError({ participantId: receiverId });
        }

        const correlationId = correlationIdFor(input.commandId);
        const result = yield* writer.appendEventsInTransaction({
          commandId: input.commandId,
          squadronId: sender.squadronId,
          acceptedAt: input.acceptedAt,
          events: [
            ...(openEvent === undefined ? [] : [openEvent]),
            {
              kind: "message.sent",
              sender: sender.participantId,
              receiver: receiverId,
              exchangeId,
              correlationId,
              payload: yield* encodeSentPayload({
                messageId,
                text: input.message,
                ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
                originSquadronId: sender.squadronId,
                receiverSquadronId: receiver.squadronId,
                ...(receiver.environmentId === null
                  ? {}
                  : { receiverEnvironmentId: receiver.environmentId }),
                exchangeRole,
                envelopeChannel: "peer",
              }),
              createdAt: input.acceptedAt,
            },
            ...(closeEvent === undefined ? [] : [closeEvent]),
          ],
        });
        if (result.committed) committed.push(...result.events);
        const sent = result.events.find((event) => event.kind === "message.sent");
        if (sent === undefined) {
          return yield* new A2AParticipantNotFoundError({ participantId: receiverId });
        }
        const opened = result.events.some((event) => event.kind === "exchange.opened");
        const closed = result.events.some((event) => event.kind === "exchange.closed");
        return {
          messageId,
          exchangeId,
          exchangeState: closed ? "closed" : exchangeState,
          joinedExistingExchange:
            exchangeId !== null && !opened && !closed ? joinedExistingExchange : false,
          durableAtSeq: sent.seq,
        } satisfies SendMessageResult;
      });

      const send: A2ASendServiceShape["send"] = (input) =>
        Effect.gen(function* () {
          const committed: Array<StoredCommEvent> = [];
          // The sender's standing is checked first so its errors win, then peers
          // are reached before the writer permit and the transaction: holding
          // either across the network would block every other send, including
          // the peer's own send back to us. The transaction re-checks both.
          const sender = yield* senderMembership(input.senderThreadId);
          // A retry of a committed send replays whatever has happened to the
          // receiver since; it never pays for, or fails on, a peer lookup.
          const replayed = yield* replayedSend(messageIdFor(input.commandId), sender.participantId);
          const remote = replayed === null ? yield* preResolveRemote(input.to) : null;
          const result = yield* writer.withPermit(
            sql.withTransaction(
              Effect.gen(function* () {
                const sender = yield* senderMembership(input.senderThreadId);
                return yield* sendInternal(input, sender, committed, remote);
              }),
            ),
          );
          yield* writer.publishCommitted(committed);
          return result;
        });

      const sendAsMachine: A2ASendServiceShape["sendAsMachine"] = (input) =>
        Effect.gen(function* () {
          const committed: Array<StoredCommEvent> = [];
          const result = yield* writer.withPermit(
            sql.withTransaction(
              Effect.gen(function* () {
                const sender = yield* machineSender(input.senderParticipantId);
                // A machine sender reaches agents on this server only; peers are not resolved for it.
                return yield* sendInternal(
                  {
                    commandId: input.commandId,
                    to: input.to,
                    message: input.message,
                    acceptedAt: input.acceptedAt,
                  },
                  sender,
                  committed,
                  null,
                );
              }),
            ),
          );
          yield* writer.publishCommitted(committed);
          return result;
        });

      const clearOwnAsk: A2ASendServiceShape["clearOwnAsk"] = (input) =>
        Effect.gen(function* () {
          const sender = yield* senderMembership(input.senderThreadId);
          const replay = yield* sql<ExistingSenderClearedRow>`
            SELECT
              created_at,
              json_extract(payload, '$.closureKind') AS closure_kind
            FROM j5_a2a_comm_event
            WHERE command_id = ${input.commandId}
              AND kind = 'exchange.closed'
              AND sender = ${sender.participantId}
              AND exchange_id = ${input.exchangeId}
            LIMIT 2
          `;
          if (replay.length === 1 && replay[0]!.closure_kind === "sender-cleared") {
            return {
              exchangeId: input.exchangeId,
              closureKind: "sender-cleared",
              closedAt: replay[0]!.created_at,
              withdrawalQueued: false,
            } satisfies ClearOwnAskOutcome;
          }

          const rows = yield* sql<ExchangeRow>`
            SELECT squadron_id, exchange_id, sender_id, receiver_id, status
            FROM j5_a2a_exchange
            WHERE exchange_id = ${input.exchangeId}
            LIMIT 2
          `;
          const exchange = rows.length === 1 ? rows[0] : undefined;
          if (exchange === undefined) {
            return yield* new A2AClearOwnAskUnknownExchangeError({
              exchangeId: input.exchangeId,
            });
          }
          if (exchange.sender_id !== sender.participantId) {
            return yield* new A2AClearOwnAskSenderMismatchError({
              exchangeId: input.exchangeId,
              callerId: sender.participantId,
              senderId: exchange.sender_id,
            });
          }
          if (exchange.status !== "open") {
            return yield* new A2AClearOwnAskAlreadyClosedError({
              exchangeId: input.exchangeId,
            });
          }

          const receiverId = ParticipantId.make(exchange.receiver_id);
          const squadronId = SquadronId.make(exchange.squadron_id);
          const correlationId = correlationIdFor(input.commandId);
          // A receiver on a peer server holds its own copy of this Exchange and
          // would keep owing a reply; a terminal notice travels the peer path to
          // close it there too.
          const remote = yield* findPeerCounterparty(sql, {
            squadronId,
            exchangeId: input.exchangeId,
            participantId: receiverId,
          });
          const withdrawal: ReadonlyArray<CommEvent> =
            remote === null
              ? []
              : [
                  {
                    kind: "message.sent",
                    sender: LIFECYCLE_PARTICIPANT_ID,
                    receiver: receiverId,
                    exchangeId: input.exchangeId,
                    correlationId,
                    payload: {
                      messageId: withdrawalMessageIdFor(input.commandId),
                      text: formatWithdrawalNotice({
                        exchangeId: input.exchangeId,
                        askerId: sender.participantId,
                      }),
                      originSquadronId: squadronId,
                      receiverSquadronId: remote.squadronId,
                      receiverEnvironmentId: remote.environmentId,
                      exchangeRole: "terminal_notice",
                      envelopeChannel: "lifecycle_notice",
                      terminal: { kind: "sender-cleared" },
                    },
                    createdAt: input.acceptedAt,
                  },
                ];
          const result = yield* ledger.appendEvents({
            commandId: input.commandId,
            squadronId,
            acceptedAt: input.acceptedAt,
            events: [
              {
                kind: "exchange.closed",
                sender: sender.participantId,
                receiver: receiverId,
                exchangeId: input.exchangeId,
                correlationId,
                payload: { closureKind: "sender-cleared" },
                createdAt: input.acceptedAt,
              },
              ...withdrawal,
            ],
          });
          const closedEvent = result.events[0];
          const eventMatchesClear =
            closedEvent !== undefined &&
            closedEvent.kind === "exchange.closed" &&
            closedEvent.exchangeId === input.exchangeId &&
            closedEvent.sender === sender.participantId &&
            typeof closedEvent.payload === "object" &&
            closedEvent.payload !== null &&
            "closureKind" in closedEvent.payload &&
            closedEvent.payload.closureKind === "sender-cleared";
          if (!eventMatchesClear) {
            return yield* new A2AClearOwnAskCommandConflictError({
              commandId: input.commandId,
              exchangeId: input.exchangeId,
            });
          }
          return {
            exchangeId: input.exchangeId,
            closureKind: "sender-cleared" as const,
            closedAt: closedEvent.createdAt,
            withdrawalQueued: result.committed && withdrawal.length > 0,
          } satisfies ClearOwnAskOutcome;
        });

      return A2ASendService.of({ send, sendAsMachine, clearOwnAsk, listParticipants });
    }),
  );
