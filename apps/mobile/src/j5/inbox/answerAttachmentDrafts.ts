import { useAtomValue } from "@effect/atom-react";
import type { ChatAttachment, EnvironmentId } from "@t3tools/contracts";

import type { DraftComposerAttachment } from "../../lib/composerImages";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  composerAttachmentUploadBlockReason,
  composerAttachmentUploadsAtom,
  composerAttachmentsStillUploading,
} from "../../state/composer-attachment-uploads";
import { environmentServerConfigsAtom } from "../../state/server";
import { clearComposerDraft, composerDraftsAtom } from "../../state/use-composer-drafts";

export interface AnswerTarget {
  readonly environmentId: EnvironmentId;
  readonly exchangeId: string;
}

export const NO_ANSWER_ATTACHMENTS: ReadonlyArray<DraftComposerAttachment> = [];

/**
 * An answer's attachments are a composer draft on the asking environment, as a pending question's
 * are, so the composer's upload worker sends them as they are added and they survive a restart.
 */
export const answerAttachmentDraftKey = (target: AnswerTarget) =>
  `${target.environmentId}:j5-answer-${encodeURIComponent(target.exchangeId)}`;

export function useAnswerDraftAttachments(target: AnswerTarget) {
  return (
    useAtomValue(composerDraftsAtom)[answerAttachmentDraftKey(target)]?.attachments ??
    NO_ANSWER_ATTACHMENTS
  );
}

function attachmentsBlocked(
  target: AnswerTarget,
  attachments: ReadonlyArray<DraftComposerAttachment>,
  states: Parameters<typeof composerAttachmentsStillUploading>[0]["states"],
  serverConfig: Parameters<typeof composerAttachmentsStillUploading>[0]["serverConfig"],
): string | null {
  if (attachments.length === 0) return null;
  const input = { environmentId: target.environmentId, attachments, serverConfig, states };
  const failed = composerAttachmentUploadBlockReason({ ...input, connected: true });
  if (failed !== null) return failed;
  if (composerAttachmentsStillUploading(input)) return "Attachments are still uploading";
  return attachments.every(
    (attachment) =>
      attachment.uploadedAttachmentId !== undefined &&
      attachment.uploadEnvironmentId === target.environmentId,
  )
    ? null
    : "Attachments are not uploaded yet";
}

/**
 * The uploaded attachments to send with an answer, read as it is sent, or why it must wait. An
 * answer carries only uploads, as a pending question's response does.
 */
export function readyAnswerAttachments(
  target: AnswerTarget,
): { readonly attachments: ReadonlyArray<ChatAttachment> } | { readonly blocked: string } {
  const attachments =
    appAtomRegistry.get(composerDraftsAtom)[answerAttachmentDraftKey(target)]?.attachments ??
    NO_ANSWER_ATTACHMENTS;
  const blocked = attachmentsBlocked(
    target,
    attachments,
    appAtomRegistry.get(composerAttachmentUploadsAtom),
    appAtomRegistry.get(environmentServerConfigsAtom).get(target.environmentId) ?? null,
  );
  if (blocked !== null) return { blocked };
  return {
    attachments: attachments.map((attachment) => ({
      type: attachment.type,
      id: attachment.uploadedAttachmentId!,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    })),
  };
}

/** The answer was delivered: the server copied its files into the agent's thread. */
export function clearAnswerAttachments(target: AnswerTarget) {
  clearComposerDraft(answerAttachmentDraftKey(target));
}
