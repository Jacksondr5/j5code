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

const ANSWER_DRAFT_MARK = ":j5-answer-";

/**
 * An answer is a composer draft on the asking environment, as a pending question's attachments
 * are, so the composer's upload worker sends its files as they are added, and its words and files
 * survive leaving the screen and a restart. The key names the answering person, so another person
 * on this device never sends them.
 */
export const answerAttachmentDraftKey = (target: AnswerTarget) =>
  `${target.environmentId}${ANSWER_DRAFT_MARK}${encodeURIComponent(
    JSON.stringify([target.personId, target.projectId, target.exchangeId]),
  )}`;

/** The `scopedInboxItemKey` of the ask a composer draft answers, or null for any other draft. */
export function answerDraftItemKey(draftKey: string): string | null {
  const at = draftKey.indexOf(ANSWER_DRAFT_MARK);
  if (at < 0) return null;
  const [personId, projectId, exchangeId] = JSON.parse(
    decodeURIComponent(draftKey.slice(at + ANSWER_DRAFT_MARK.length)),
  ) as [string, string, string];
  return JSON.stringify([draftKey.slice(0, at), personId, projectId, exchangeId]);
}

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
