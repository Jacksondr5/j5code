import type { ChatAttachment } from "@t3tools/contracts";
import type { ScopedHumanInboxItem } from "@t3tools/contracts/j5";

import {
  composerAttachmentUploadBlockReason,
  composerAttachmentsStillUploading,
} from "../../lib/composerAttachmentUploadQueue";
import type { DraftComposerAttachment } from "../../lib/composerImages";

export type AnswerTarget = Pick<
  ScopedHumanInboxItem,
  "environmentId" | "personId" | "projectId" | "exchangeId"
>;

type UploadInput = Parameters<typeof composerAttachmentsStillUploading>[0];

/**
 * An answer's attachments are a composer draft on the asking environment, as a pending question's
 * are, so the composer's upload worker sends them as they are added and they survive a restart.
 * The key names the answering person as the answer's words do, so another person on this device
 * never sends them.
 */
export const answerAttachmentDraftKey = (target: AnswerTarget) =>
  `${target.environmentId}:j5-answer-${encodeURIComponent(
    JSON.stringify([target.personId, target.projectId, target.exchangeId]),
  )}`;

/**
 * The uploaded attachments an answer sends, or why it must wait: one still being picked or pasted,
 * a failed or unfinished upload. An answer carries only uploads, as a pending question's response
 * does.
 */
export function answerAttachmentsReadiness(input: {
  readonly target: AnswerTarget;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  /** Picks and pastes still turning into attachments. */
  readonly preparing: number;
  readonly states: UploadInput["states"];
  readonly serverConfig: UploadInput["serverConfig"];
}): { readonly attachments: ReadonlyArray<ChatAttachment> } | { readonly blocked: string } {
  if (input.preparing > 0) return { blocked: "Attachments are still being added" };
  const { environmentId } = input.target;
  const upload = {
    environmentId,
    attachments: input.attachments,
    serverConfig: input.serverConfig,
    states: input.states,
  };
  const failed = composerAttachmentUploadBlockReason({ ...upload, connected: true });
  if (failed !== null) return { blocked: failed };
  if (composerAttachmentsStillUploading(upload)) {
    return { blocked: "Attachments are still uploading" };
  }
  const attachments: ChatAttachment[] = [];
  for (const attachment of input.attachments) {
    if (
      attachment.uploadedAttachmentId === undefined ||
      attachment.uploadEnvironmentId !== environmentId
    ) {
      return { blocked: "Attachments are not uploaded yet" };
    }
    attachments.push({
      type: attachment.type,
      id: attachment.uploadedAttachmentId,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    } as ChatAttachment);
  }
  return { attachments };
}
