import {
  getProviderAttachmentLimitError,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import {
  clampFileAttachmentUploadBytes,
  fileAttachmentTooLargeMessage,
} from "@t3tools/client-runtime/state/attachments";

import {
  classifyComposerAttachmentFile,
  composerFileAttachmentMimeType,
  normalizeComposerImageFileMimeType,
} from "../../components/chat/composerAttachmentFiles";
import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import { isHeicImageFile } from "../../lib/imageCompression";

export type AnswerAttachment = ComposerImageAttachment | ComposerFileAttachment;

/**
 * Turns picked, pasted or dropped files into an answer's attachments, or says why they cannot
 * go. An answer only sends uploads, so a server that takes no file uploads takes images only.
 */
export function stageAnswerAttachments(input: {
  readonly current: ReadonlyArray<AnswerAttachment>;
  readonly files: ReadonlyArray<File>;
  /** The server's advertised upload limit for files; null when it takes none. */
  readonly maxFileBytes: number | null;
  readonly newId: () => string;
  readonly previewUrl: (file: File) => string;
}): { readonly attachments: ReadonlyArray<AnswerAttachment> } | { readonly error: string } {
  const staged: AnswerAttachment[] = [];
  for (const picked of input.files) {
    const kind = classifyComposerAttachmentFile(picked);
    if (kind === "unsupported-image" || (kind === "image" && isHeicImageFile(picked))) {
      return { error: `${picked.name} is an image type the agent cannot read.` };
    }
    if (kind === "image") {
      const file = normalizeComposerImageFileMimeType(picked);
      if (file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        return {
          error: fileAttachmentTooLargeMessage(picked.name, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES),
        };
      }
      staged.push({
        type: "image",
        id: input.newId(),
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl: "",
        file,
      });
      continue;
    }
    if (input.maxFileBytes === null) {
      return { error: "This server does not accept files. Attach images only." };
    }
    const maxFileBytes = clampFileAttachmentUploadBytes(input.maxFileBytes);
    if (picked.size > maxFileBytes) {
      return { error: fileAttachmentTooLargeMessage(picked.name, maxFileBytes) };
    }
    staged.push({
      type: "file",
      id: input.newId(),
      name: picked.name,
      mimeType: composerFileAttachmentMimeType(picked),
      sizeBytes: picked.size,
      file: picked,
    });
  }
  const limitError = getProviderAttachmentLimitError([...input.current, ...staged]);
  if (limitError !== undefined) return { error: limitError };
  // Previews are made last, so a refused batch leaves no object URL behind.
  return {
    attachments: staged.map((attachment) =>
      attachment.type === "image"
        ? { ...attachment, previewUrl: input.previewUrl(attachment.file) }
        : attachment,
    ),
  };
}
