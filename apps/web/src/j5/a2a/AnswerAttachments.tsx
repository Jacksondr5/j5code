import type { ChatAttachment, EnvironmentId } from "@t3tools/contracts";
import { answerAttachmentSupport } from "@t3tools/client-runtime/j5/inbox";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { FileIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { ComposerAttachButton } from "../../components/chat/ComposerAttachmentStrip";
import { shouldHandleComposerAttachmentPaste } from "../../components/chat/composerAttachmentFiles";
import { Button } from "../../components/ui/button";
import { composerFileNeedsReattach, useComposerDraftStore } from "../../composerDraftStore";
import {
  getUploadedAttachments,
  releaseDraftAttachment,
  retryAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "../../lib/attachmentUploadQueue";
import {
  attachmentUploadBlockReason,
  formatAttachmentUploadProgress,
} from "../../lib/attachmentUploadState";
import { randomUUID } from "../../lib/utils";
import { useServerConfigs } from "../../state/entities";
import { type AnswerAttachment, stageAnswerAttachments } from "./answerAttachments.logic";
import {
  clearInboxAnswerDraft,
  inboxAnswerDraftId,
  inboxAnswerDrafts,
  persistInboxAnswerImages,
} from "./inboxAnswerDrafts";

const NO_ATTACHMENTS: ReadonlyArray<AnswerAttachment> = [];

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const rest = { ...record };
  delete rest[key];
  return rest;
}

const needsReattach = (attachment: AnswerAttachment) =>
  attachment.type === "file" && composerFileNeedsReattach(attachment);

/** Whether an environment takes answer attachments: only uploads can go with an answer. */
export function useAnswerAttachmentSupport(environmentId: EnvironmentId | undefined) {
  const configs = useServerConfigs();
  return answerAttachmentSupport(
    environmentId === undefined ? undefined : configs.get(environmentId)?.environment.capabilities,
  );
}

/**
 * Uploads a shown answer's files again after a reload, once the person may answer it: the upload
 * queue lives in memory, and it refuses to start before the environment's grant arrives.
 */
export function useRestoredAnswerUploads(
  key: string,
  environmentId: EnvironmentId | undefined,
  mayAnswer: boolean,
) {
  const target = inboxAnswerDraftId(key);
  const draft = useComposerDraftStore((state) => state.draftsByThreadKey[target]);
  const supported = useAnswerAttachmentSupport(environmentId) !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restarts uploads held only in memory for files restored from a saved draft; repeat calls are no-ops.
  useEffect(() => {
    if (!mayAnswer || !supported || draft === undefined || environmentId === undefined) return;
    for (const attachment of [...draft.images, ...draft.files]) {
      if (needsReattach(attachment)) continue;
      startAttachmentUpload({ environmentId, image: attachment, draftTarget: target });
    }
  }, [mayAnswer, supported, draft, environmentId, target]);
}

/**
 * The files on each open answer, by the answer's key, kept in its saved draft and uploaded to the
 * asking environment as they are added. An answer that is delivered or removed releases them.
 */
export function useAnswerAttachments() {
  const drafts = inboxAnswerDrafts(useComposerDraftStore((state) => state.draftsByThreadKey));
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const uploadsByImageId = useAttachmentUploadStore((state) => state.uploadsByImageId);
  const setError = (key: string, error: string | null) =>
    setErrors((current) => (error === null ? without(current, key) : { ...current, [key]: error }));
  const list = (key: string): ReadonlyArray<AnswerAttachment> => {
    const draft = drafts.get(key);
    return draft === undefined || (draft.images.length === 0 && draft.files.length === 0)
      ? NO_ATTACHMENTS
      : [...draft.images, ...draft.files];
  };
  return {
    list,
    error: (key: string) => errors[key] ?? null,
    add: (
      key: string,
      environmentId: EnvironmentId,
      maxFileBytes: number | null,
      files: ReadonlyArray<File>,
    ) => {
      const result = stageAnswerAttachments({
        current: list(key),
        files,
        maxFileBytes,
        newId: randomUUID,
        previewUrl: (file) => URL.createObjectURL(file),
      });
      if ("error" in result) {
        setError(key, result.error);
        return;
      }
      setError(key, null);
      const target = inboxAnswerDraftId(key);
      const store = useComposerDraftStore.getState();
      const images = result.attachments.filter((attachment) => attachment.type === "image");
      store.addImages(target, images, { allowDuplicates: true });
      store.addFiles(
        target,
        result.attachments.filter((attachment) => attachment.type === "file"),
        { allowDuplicates: true },
      );
      for (const attachment of result.attachments) {
        startAttachmentUpload({ environmentId, image: attachment, draftTarget: target });
      }
      if (images.length > 0) void persistInboxAnswerImages(key);
    },
    remove: (key: string, id: string) => {
      const attachment = list(key).find((candidate) => candidate.id === id);
      if (attachment === undefined) return;
      releaseDraftAttachment(attachment);
      const store = useComposerDraftStore.getState();
      if (attachment.type === "image") store.removeImage(inboxAnswerDraftId(key), id);
      else store.removeFile(inboxAnswerDraftId(key), id);
    },
    /** The server copied the files into the agent's thread; the uploads are no longer needed. */
    delivered: (key: string) => {
      clearInboxAnswerDraft(key);
      setError(key, null);
    },
    /** The uploaded files to send, or why the answer must wait. */
    ready: (
      key: string,
      environmentId: EnvironmentId,
    ): { readonly attachments: ReadonlyArray<ChatAttachment> } | { readonly blocked: string } => {
      const attachments = list(key);
      if (attachments.length === 0) return { attachments: [] };
      const lost = attachments.find(needsReattach);
      if (lost !== undefined) return { blocked: `Remove ${lost.name} and attach it again.` };
      const uploaded = getUploadedAttachments({ environmentId, images: attachments });
      if (uploaded !== null) return { attachments: uploaded };
      return {
        blocked:
          attachmentUploadBlockReason({
            imageIds: attachments.map((attachment) => attachment.id),
            uploadsByImageId,
            environmentId,
          }) ?? "An attachment failed to upload. Retry it or remove it.",
      };
    },
  };
}

export type AnswerAttachmentsState = ReturnType<typeof useAnswerAttachments>;

/** Paste and drop handlers that turn files into attachments and leave plain text alone. */
export function answerAttachmentInputHandlers(onFiles: (files: ReadonlyArray<File>) => void) {
  return {
    onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(event.clipboardData.files);
      const plainText = event.clipboardData.getData("text/plain");
      if (files.length === 0 || !shouldHandleComposerAttachmentPaste({ files, plainText })) return;
      event.preventDefault();
      onFiles(files);
    },
    onDragOver: (event: React.DragEvent<HTMLTextAreaElement>) => {
      if (event.dataTransfer.types.includes("Files")) event.preventDefault();
    },
    onDrop: (event: React.DragEvent<HTMLTextAreaElement>) => {
      const files = Array.from(event.dataTransfer.files);
      if (files.length === 0) return;
      event.preventDefault();
      onFiles(files);
    },
  };
}

export function AnswerAttachButton(props: {
  readonly onFiles: (files: ReadonlyArray<File>) => void;
  readonly focusAnswer: () => void;
}) {
  return (
    <ComposerAttachButton
      addComposerAttachments={async (files) => {
        props.onFiles(files);
        return false;
      }}
      focusComposer={props.focusAnswer}
    />
  );
}

export function AnswerAttachmentList(props: {
  readonly answerKey: string;
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<AnswerAttachment>;
  readonly error: string | null;
  /** Null while the answer is being delivered: the server is claiming these uploads. */
  readonly onRemove: ((id: string) => void) | null;
}) {
  const uploadsByImageId = useAttachmentUploadStore((state) => state.uploadsByImageId);
  if (props.attachments.length === 0 && props.error === null) return null;
  return (
    <div className="flex flex-col gap-2">
      {props.attachments.length > 0 ? (
        <ul aria-label="Attachments" className="flex flex-wrap gap-2">
          {props.attachments.map((attachment) => {
            const upload = uploadsByImageId[attachment.id];
            const status = needsReattach(attachment)
              ? "Attach it again"
              : upload?.status === "uploading"
                ? `Uploading ${formatAttachmentUploadProgress(upload.progress)}`
                : upload?.status === "failed"
                  ? "Upload failed"
                  : formatAttachmentSize(attachment.sizeBytes);
            return (
              <li
                className="flex max-w-64 items-center gap-2 rounded-md border border-border bg-muted/40 py-1 ps-1 pe-0.5 text-xs"
                key={attachment.id}
              >
                {attachment.type === "image" ? (
                  <img
                    alt=""
                    className="size-8 shrink-0 rounded-sm object-cover"
                    src={attachment.previewUrl}
                  />
                ) : (
                  <FileIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium text-foreground">{attachment.name}</span>
                  <span
                    className={
                      upload?.status === "failed" ? "text-destructive" : "text-muted-foreground"
                    }
                  >
                    {status}
                  </span>
                </span>
                {upload?.status === "failed" ? (
                  <Button
                    aria-label={`Retry uploading ${attachment.name}`}
                    onClick={() =>
                      retryAttachmentUpload({
                        environmentId: props.environmentId,
                        image: attachment,
                        draftTarget: inboxAnswerDraftId(props.answerKey),
                      })
                    }
                    size="icon-xs"
                    type="button"
                    variant="ghost"
                  >
                    <RefreshCwIcon aria-hidden />
                  </Button>
                ) : null}
                <Button
                  aria-label={`Remove ${attachment.name}`}
                  disabled={props.onRemove === null}
                  onClick={() => props.onRemove?.(attachment.id)}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <XIcon aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {props.error === null ? null : (
        <p className="text-sm text-destructive" role="alert">
          {props.error}
        </p>
      )}
    </div>
  );
}
