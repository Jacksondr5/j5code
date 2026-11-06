import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  type ChatAttachment,
  CommandId,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import type {
  AllowPersonaOnceRequest,
  AnswerHumanExchangeRequest,
  SavePersonaDraftRequest,
  AnswerHumanExchangeResponse,
  CrewArchiveRequest,
  CrewArchiveResponse,
  CrewWorktreeCleanupAnswerRequest,
  CrewWorktreeCleanupAnswerResponse,
  CrewProposalPreviewRequest,
  CrewProposalPreviewResponse,
  CrewProposalResolveRequest,
  CrewProposalResolveResponse,
  CrewRuntimeRequestRespondRequest,
  CrewRuntimeRequestRespondResponse,
  CrewStopRequest,
  CrewStopResponse,
} from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import type { SqlError } from "effect/sql/SqlError";

import { ServerConfig } from "../../config.ts";
import {
  AgentPersonaEscalationError,
  AgentPersonaEscalations,
  allowedOnceReply,
} from "../agents/agentPersonaEscalation.ts";
import {
  AgentPersonaDraftError,
  AgentPersonaDrafts,
  savedPersonaReply,
} from "../agents/agentPersonaDrafts.ts";
import {
  AttachmentClaimError,
  attachmentIsPendingUpload,
  claimPendingAttachments,
} from "../../orchestration-v2/AttachmentClaims.ts";
import { DocumentText } from "../../provider/DocumentText.ts";
import { PlaybookStore } from "../playbooks/PlaybookStore.ts";
import { ArchiveCrewService } from "./ArchiveCrewService.ts";
import { CommCommandId, ExchangeId, ParticipantId } from "./contracts.ts";
import { projectCrewProposal } from "./crewProposalProjection.ts";
import { CrewProposalService } from "./CrewProposalService.ts";
import { CrewRuntimeRequestService } from "./CrewRuntimeRequestService.ts";
import { CrewStopService } from "./CrewStopService.ts";
import { CrewWorktrees } from "./CrewWorktrees.ts";
import { A2ADeliveryWorker } from "./DeliveryWorker.ts";
import { A2AHumanInbox } from "./HumanInboxService.ts";
import { crewSeatRequestKey, lifecycleCommandId } from "./spawnIds.ts";

const HUMAN_STOP_SESSION = "j5-crew-stop-human";
const HUMAN_ARCHIVE_SESSION = "j5-crew-archive-human";

type Failure<Method> = Method extends (...args: never) => Effect.Effect<unknown, infer E>
  ? E
  : never;

/**
 * What a person does from a client, beside `ClientReadsService`. The person is not a Crew
 * participant: there is no Captain check, each act is keyed by a fresh request id, and the Crew
 * and Exchange services underneath do the work. Failures are theirs, unchanged.
 */
export class ClientActionsService extends Context.Service<
  ClientActionsService,
  {
    /** Resolve the runtime settings the roster card shows, and the token an approval must carry. */
    readonly previewCrewProposal: (
      input: CrewProposalPreviewRequest,
    ) => Effect.Effect<
      CrewProposalPreviewResponse,
      Failure<CrewProposalService["Service"]["preview"]>
    >;
    /** Approve (with the final seats) or decline one proposal; answers with it as the card reads it. */
    readonly resolveCrewProposal: (
      input: CrewProposalResolveRequest,
      /** Who is answering, as the Captain is told; given only for a shared conversation. */
      decidedBy?: string | null,
    ) => Effect.Effect<
      typeof CrewProposalResolveResponse.Type,
      Failure<CrewProposalService["Service"]["resolve"]>
    >;
    /** Interrupt every running seat; nothing is retired. Each call is one stop. */
    readonly stopCrew: (
      input: CrewStopRequest,
    ) => Effect.Effect<CrewStopResponse, Failure<CrewStopService["Service"]["stop"]>>;
    /**
     * Retire a Crew as a unit. The dialog the person confirmed already listed every seat's open
     * asks and running turns, so the archive runs with its confirmation satisfied; seats that
     * already retired replay as already archived.
     */
    readonly archiveCrew: (
      input: CrewArchiveRequest,
    ) => Effect.Effect<CrewArchiveResponse, Failure<ArchiveCrewService["Service"]["archive"]>>;
    /** Answer a seat's provider approval from the Inbox; refused once the request resolved. */
    readonly respondCrewRuntimeRequest: (
      input: CrewRuntimeRequestRespondRequest,
      /**
       * Writes down who is answering, given the command that will carry the answer, before it is
       * sent; a shared conversation's prompt shows who answered once upstream settles it.
       */
      claim?: (command: {
        readonly threadId: ThreadId;
        readonly requestId: RuntimeRequestId;
        readonly commandId: CommandId;
      }) => Effect.Effect<void>,
    ) => Effect.Effect<
      CrewRuntimeRequestRespondResponse,
      Failure<CrewRuntimeRequestService["Service"]["respond"]>
    >;
    /** Answer an Exchange an agent opened with the person, then wake delivery. */
    readonly answerHumanExchange: (
      input: AnswerHumanExchangeRequest & { readonly personId: ParticipantId },
      beforeReply?: Parameters<A2AHumanInbox["Service"]["answer"]>[1],
    ) => Effect.Effect<
      typeof AnswerHumanExchangeResponse.Type,
      Failure<A2AHumanInbox["Service"]["answer"]>
    >;
    /**
     * The Owner's "Allow this once": answers an ask escalating a refused persona with the fixed
     * reply, then grants its one waiver for the asking agent's retry.
     */
    readonly allowPersonaOnce: (
      input: AllowPersonaOnceRequest & { readonly personId: ParticipantId },
      beforeReply?: Parameters<A2AHumanInbox["Service"]["answer"]>[1],
    ) => Effect.Effect<
      typeof AnswerHumanExchangeResponse.Type,
      Failure<A2AHumanInbox["Service"]["answer"]> | AgentPersonaEscalationError | SqlError
    >;
    /**
     * The Owner's "Save persona": writes the ask's persona draft to the library, then answers the
     * ask with the fixed reply. A retry of the same request replays the answer.
     */
    readonly savePersonaDraft: (
      input: SavePersonaDraftRequest & { readonly personId: ParticipantId },
      beforeReply?: Parameters<A2AHumanInbox["Service"]["answer"]>[1],
    ) => Effect.Effect<
      typeof AnswerHumanExchangeResponse.Type,
      Failure<A2AHumanInbox["Service"]["answer"]> | AgentPersonaDraftError | SqlError
    >;
    /** Decide the worktree cleanup an archive filed in the Inbox; refused once decided. */
    readonly answerCrewWorktreeCleanup: (
      input: CrewWorktreeCleanupAnswerRequest,
    ) => Effect.Effect<
      typeof CrewWorktreeCleanupAnswerResponse.Type,
      Failure<CrewWorktrees["Service"]["answerCleanup"]>
    >;
  }
>()("t3/j5/a2a/ClientActionsService") {}

/** A seat whose thread never came to exist has no result a client knows. */
const createdSeats = <Result extends string>(
  members: ReadonlyArray<{
    readonly seatName: string;
    readonly participantId: string;
    readonly result: Result | "never_created";
  }>,
) =>
  members.flatMap((member) =>
    member.result === "never_created"
      ? []
      : [{ seat: member.seatName, participantId: member.participantId, result: member.result }],
  );

const make = Effect.gen(function* () {
  const proposals = yield* CrewProposalService;
  const stops = yield* CrewStopService;
  const archives = yield* ArchiveCrewService;
  const runtimeRequests = yield* CrewRuntimeRequestService;
  const inbox = yield* A2AHumanInbox;
  const worker = yield* A2ADeliveryWorker;
  const worktrees = yield* CrewWorktrees;
  const escalations = yield* AgentPersonaEscalations;
  const drafts = yield* AgentPersonaDrafts;
  // A random source that fails is the host's fault, not a refusal a client can act on.
  const freshId = (yield* Crypto.Crypto).randomUUIDv4().pipe(Effect.orDie);
  const projectProposal = projectCrewProposal(yield* PlaybookStore);
  const claimContext = yield* Effect.context<FileSystem.FileSystem | ServerConfig | DocumentText>();
  // Only fresh uploads: an attachment id that names a thread would let an answer hand the agent
  // a file from a thread the person may not read.
  const claimAnswerAttachments = (
    threadId: ThreadId,
    attachments: ReadonlyArray<ChatAttachment>,
  ) =>
    attachments.every(attachmentIsPendingUpload)
      ? claimPendingAttachments({ threadId, attachments }).pipe(
          Effect.map((claimed) => claimed.attachments),
          Effect.provideContext(claimContext),
        )
      : Effect.fail(
          new AttachmentClaimError({ message: "An answer can only attach new uploads." }),
        );

  return ClientActionsService.of({
    previewCrewProposal: Effect.fn("ClientActionsService.previewCrewProposal")(function (input) {
      return proposals.preview(input);
    }),
    resolveCrewProposal: Effect.fn("ClientActionsService.resolveCrewProposal")(
      function (input, decidedBy) {
        return proposals.resolve({ ...input, decidedBy }).pipe(
          Effect.flatMap((result) =>
            projectProposal(result.proposal).pipe(
              Effect.map((proposal) => ({
                proposal,
                crewInstanceId: result.instance?.id ?? null,
              })),
            ),
          ),
        );
      },
    ),
    stopCrew: Effect.fn("j5.a2a.clientActions.stopCrew")(
      function* ({ crewInstanceId }) {
        const requestKey = yield* freshId;
        return yield* stops.stop({
          callerParticipantId: null,
          projectId: null,
          crewInstanceId,
          commandIds: (seatName) => ({
            interruptCommandId: CommandId.make(
              lifecycleCommandId({
                providerSessionId: HUMAN_STOP_SESSION,
                requestKey: crewSeatRequestKey(requestKey, seatName),
                operation: "stop-crew-interrupt",
              }),
            ),
          }),
        });
      },
      Effect.map((result) => ({
        crewInstanceId: result.crewInstanceId,
        members: createdSeats(result.members),
      })),
    ),
    archiveCrew: Effect.fn("j5.a2a.clientActions.archiveCrew")(function* ({ crewInstanceId }) {
      const requestKey = yield* freshId;
      const archivedAt = DateTime.formatIso(yield* DateTime.now);
      const result = yield* archives.archive({
        providerSessionId: HUMAN_ARCHIVE_SESSION,
        callerParticipantId: null,
        projectId: null,
        crewInstanceId,
        clientRequestKey: requestKey,
        confirmationSatisfied: true,
        archivedAt,
        commandIds: (seatName) => ({
          interruptCommandId: lifecycleCommandId({
            providerSessionId: HUMAN_ARCHIVE_SESSION,
            requestKey: crewSeatRequestKey(requestKey, seatName),
            operation: "archive-crew-interrupt",
          }),
          archiveCommandId: lifecycleCommandId({
            providerSessionId: HUMAN_ARCHIVE_SESSION,
            requestKey: crewSeatRequestKey(requestKey, seatName),
            operation: "archive-crew-thread",
          }),
        }),
      });
      return {
        crewInstanceId,
        status: result.status,
        members: createdSeats(result.members),
        worktrees: result.worktrees,
      };
    }),
    respondCrewRuntimeRequest: Effect.fn("ClientActionsService.respondCrewRuntimeRequest")(
      function ({ threadId, requestId, decision }, claim) {
        return freshId.pipe(
          Effect.flatMap((id) => {
            // Fresh per answer, so a second answer is refused by the request's state.
            const commandId = CommandId.make(`j5-crew-runtime-request:${id}`);
            return (claim?.({ threadId, requestId, commandId }) ?? Effect.void).pipe(
              Effect.andThen(runtimeRequests.respond({ threadId, requestId, decision, commandId })),
            );
          }),
          Effect.as({ threadId, requestId }),
        );
      },
    ),
    answerHumanExchange: Effect.fn("j5.a2a.clientActions.answerHumanExchange")(
      function* (input, beforeReply) {
        const acceptedAt = DateTime.formatIso(yield* DateTime.now);
        const result = yield* inbox.answer(
          {
            commandId: CommCommandId.make(
              `command:j5:a2a:human:${encodeURIComponent(input.personId)}:${encodeURIComponent(input.exchangeId)}:${encodeURIComponent(input.clientRequestId)}`,
            ),
            personId: input.personId,
            exchangeId: ExchangeId.make(input.exchangeId),
            message: input.message,
            ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
            acceptedAt,
          },
          beforeReply,
          claimAnswerAttachments,
        );
        yield* worker.notify;
        return { result };
      },
    ),
    allowPersonaOnce: Effect.fn("j5.a2a.clientActions.allowPersonaOnce")(
      function* (input, beforeReply) {
        const grant = yield* escalations.grantable(input.exchangeId);
        const acceptedAt = DateTime.formatIso(yield* DateTime.now);
        const result = yield* inbox.answer(
          {
            commandId: CommCommandId.make(
              `command:j5:a2a:human:${encodeURIComponent(input.personId)}:${encodeURIComponent(input.exchangeId)}:${encodeURIComponent(input.clientRequestId)}`,
            ),
            personId: input.personId,
            exchangeId: ExchangeId.make(input.exchangeId),
            message: allowedOnceReply(grant),
            acceptedAt,
          },
          beforeReply,
          claimAnswerAttachments,
        );
        // Granted once the reply is committed, so an ask someone else answered first grants nothing.
        yield* escalations.markGranted({
          escalationId: grant.escalationId,
          grantedBy: input.personId,
        });
        yield* worker.notify;
        return { result };
      },
    ),
    savePersonaDraft: Effect.fn("j5.a2a.clientActions.savePersonaDraft")(
      function* (input, beforeReply) {
        const draft = (yield* drafts.forExchanges([input.exchangeId])).get(input.exchangeId);
        if (draft === undefined)
          return yield* new AgentPersonaDraftError({
            message: "This ask doesn't carry a persona draft.",
          });
        // A typed reply or a cleared ask closes it, and that decides the draft: nothing saves.
        if (
          draft.status === "open" &&
          !(yield* inbox.list(input.personId, "open")).some(
            (item) => item.exchangeId === input.exchangeId,
          )
        )
          return yield* new AgentPersonaDraftError({
            message: "This ask is already answered, so its draft can't be saved.",
          });
        // Saved before the reply, so a stale draft never answers the ask with "Saved".
        const saved = yield* drafts.save({ exchangeId: input.exchangeId, savedBy: input.personId });
        const result = yield* inbox.answer(
          {
            commandId: CommCommandId.make(
              `command:j5:a2a:human:${encodeURIComponent(input.personId)}:${encodeURIComponent(input.exchangeId)}:${encodeURIComponent(input.clientRequestId)}`,
            ),
            personId: input.personId,
            exchangeId: ExchangeId.make(input.exchangeId),
            message: savedPersonaReply(saved),
            acceptedAt: DateTime.formatIso(yield* DateTime.now),
          },
          beforeReply,
          claimAnswerAttachments,
        );
        yield* worker.notify;
        return { result };
      },
    ),
    answerCrewWorktreeCleanup: Effect.fn("j5.a2a.clientActions.answerCrewWorktreeCleanup")(
      function* ({ itemId, removePaths }) {
        return { item: yield* worktrees.answerCleanup({ itemId, removePaths }) };
      },
    ),
  });
});

// The runtime layer carries no Crypto of its own; the service brings the Node one along.
export const layer = Layer.effect(ClientActionsService, make).pipe(Layer.provide(NodeCrypto.layer));
