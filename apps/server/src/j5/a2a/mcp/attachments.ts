import { OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { ServerConfig } from "../../../config.ts";
import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import { readWritableThread, unavailable } from "../../../mcp/threadAccess.ts";
import { resolveAttachmentReferences } from "../../../mcp/toolkits/attachment/handlers.ts";
import { McpAttachmentInput } from "../../../mcp/toolkits/attachment/input.ts";
import {
  claimPendingAttachments,
  releaseClaimedAttachments,
} from "../../../orchestration-v2/AttachmentClaims.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { A2ADeliveryWorker } from "../DeliveryWorker.ts";
import {
  A2ASendService,
  A2ASenderNotJoinedError,
  A2ASenderRetiredError,
  A2AHomeMembershipStateError,
  A2AParticipantNotFoundError,
  A2AAmbiguousParticipantError,
  A2AParticipantArchivedError,
  A2AHumanAskOrReplyRequiredError,
} from "../SendService.ts";
import { CommCommandId, SendMessageResult } from "../contracts.ts";

export const J5AttachmentSendToolkit = Toolkit.make(
  Tool.make("t3_thread_send_attachments", {
    description:
      "Send uploaded attachments to another registered agent in the calling project through durable J5 messaging. Specify the target threadId from list_participants. Each call creates a new message. Success means accepted for delivery, not that the agent has received or processed it. Provider attachment support still applies.",
    parameters: Schema.Struct({
      threadId: ThreadId,
      message: Schema.optional(Schema.String.check(Schema.isMaxLength(120000))),
      attachments: Schema.Array(McpAttachmentInput).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(8),
      ),
    }),
    success: Schema.Struct({ threadId: ThreadId, ...SendMessageResult.fields }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      McpInvocationContext,
      ThreadManagementService,
      A2ASendService,
      A2ADeliveryWorker,
      ServerConfig,
      FileSystem.FileSystem,
      Crypto.Crypto,
    ],
  })
    .annotate(Tool.Destructive, true)
    .annotate(Tool.OpenWorld, true),
);

const isMcpFailure = Schema.is(OrchestratorMcpFailure);
// These plain-send refusals are raised inside the ledger transaction, before commit.
const isSendRefusal = Schema.is(
  Schema.Union([
    A2ASenderNotJoinedError,
    A2ASenderRetiredError,
    A2AHomeMembershipStateError,
    A2AParticipantNotFoundError,
    A2AAmbiguousParticipantError,
    A2AParticipantArchivedError,
    A2AHumanAskOrReplyRequiredError,
  ]),
);

export const J5AttachmentSendHandlersLive = J5AttachmentSendToolkit.toLayer({
  t3_thread_send_attachments: (input) =>
    Effect.gen(function* () {
      const { scope, caller, projection } = yield* readWritableThread(input.threadId, ["messages"]);
      if (input.threadId === caller.id)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Self-messaging is not supported. Choose another agent from list_participants.",
        });
      const send = yield* A2ASendService;
      const directory = yield* send.listParticipants(scope.threadId);
      const target = directory.find(
        (row) =>
          row.participant.kind === "agent" &&
          row.participant.threadId === input.threadId &&
          row.canReceiveMessage,
      );
      if (target === undefined || projection.thread.archivedAt !== null)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "The target is not an addressable agent. Call list_participants before retrying.",
        });
      const references = yield* resolveAttachmentReferences(
        input.attachments,
        projection.messages.flatMap((message) => message.attachments),
      );
      const claimed = yield* claimPendingAttachments({
        threadId: input.threadId,
        attachments: references,
      });
      const crypto = yield* Crypto.Crypto;
      const result = yield* send
        .send({
          commandId: CommCommandId.make(`command:j5:a2a:attachments:${yield* crypto.randomUUIDv4}`),
          senderThreadId: scope.threadId,
          to: target.participantId,
          message:
            input.message?.trim() ||
            `Attached: ${claimed.attachments.map((attachment) => attachment.name).join(", ")}`,
          attachments: claimed.attachments,
          acceptedAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
        })
        .pipe(
          Effect.tapError((error) =>
            isSendRefusal(error) ? releaseClaimedAttachments(claimed.claimedPaths) : Effect.void,
          ),
        );
      // Storage errors and defects leave acceptance uncertain; retain their claims.
      yield* (yield* A2ADeliveryWorker).notify;
      return { threadId: input.threadId, ...result };
    }).pipe(
      Effect.mapError((cause) =>
        isMcpFailure(cause)
          ? cause
          : isSendRefusal(cause)
            ? new OrchestratorMcpFailure({ code: "orchestration_error", message: cause.message })
            : unavailable(),
      ),
      Effect.catchDefect(() => Effect.fail(unavailable())),
    ),
});
