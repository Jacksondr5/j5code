import { useAtomValue } from "@effect/atom-react";
import type { ChatAttachment } from "@t3tools/contracts";

import type { DraftComposerAttachment } from "../../lib/composerImages";
import { appAtomRegistry } from "../../state/atom-registry";
import { composerAttachmentUploadsAtom } from "../../state/composer-attachment-uploads";
import {
  changeQuestionAttachmentPreparation,
  questionAttachmentPreparationAtom,
} from "../../state/question-attachments";
import { environmentServerConfigsAtom } from "../../state/server";
import { composerDraftsAtom } from "../../state/use-composer-drafts";
import {
  answerAttachmentDraftKey,
  answerAttachmentsReadiness,
  type AnswerTarget,
} from "./answerAttachments.logic";
import { clearAnswerDraft } from "./answerDrafts";

export { answerAttachmentDraftKey, type AnswerTarget } from "./answerAttachments.logic";

const NO_ANSWER_ATTACHMENTS: ReadonlyArray<DraftComposerAttachment> = [];

export function useAnswerDraftAttachments(target: AnswerTarget) {
  return (
    useAtomValue(composerDraftsAtom)[answerAttachmentDraftKey(target)]?.attachments ??
    NO_ANSWER_ATTACHMENTS
  );
}

/**
 * Holds the answer while a pick or paste turns into attachments, with upstream's reservation for a
 * pending question's attachments (keyed by draft, so an answer's key is its own). Returns whether
 * the reservation still stands when the work finishes; a delivered answer drops it, and its late
 * files are then released rather than kept in a draft nobody sends.
 */
export async function whileAddingAnswerAttachments<T>(
  target: AnswerTarget,
  work: (stillWanted: () => boolean) => Promise<T>,
): Promise<T> {
  const key = answerAttachmentDraftKey(target);
  changeQuestionAttachmentPreparation(key, 1);
  try {
    return await work(() => (appAtomRegistry.get(questionAttachmentPreparationAtom)[key] ?? 0) > 0);
  } finally {
    changeQuestionAttachmentPreparation(key, -1);
  }
}

/** The uploaded attachments to send with an answer, read as it is sent, or why it must wait. */
export function readyAnswerAttachments(
  target: AnswerTarget,
): { readonly attachments: ReadonlyArray<ChatAttachment> } | { readonly blocked: string } {
  const key = answerAttachmentDraftKey(target);
  return answerAttachmentsReadiness({
    target,
    attachments: appAtomRegistry.get(composerDraftsAtom)[key]?.attachments ?? NO_ANSWER_ATTACHMENTS,
    preparing: appAtomRegistry.get(questionAttachmentPreparationAtom)[key] ?? 0,
    states: appAtomRegistry.get(composerAttachmentUploadsAtom),
    serverConfig:
      appAtomRegistry.get(environmentServerConfigsAtom).get(target.environmentId) ?? null,
  });
}

/** The answer was delivered: the server copied its files into the agent's thread. */
export const clearAnswerAttachments = clearAnswerDraft;
