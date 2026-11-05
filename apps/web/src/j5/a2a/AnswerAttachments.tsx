import type { ChatAttachment, EnvironmentId } from "@t3tools/contracts";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { FileIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ComposerAttachButton } from "../../components/chat/ComposerAttachmentStrip";
import { shouldHandleComposerAttachmentPaste } from "../../components/chat/composerAttachmentFiles";
import { Button } from "../../components/ui/button";
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

const NO_ATTACHMENTS: ReadonlyArray<AnswerAttachment> = [];

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const rest = { ...record };
  delete rest[key];
  return rest;
}

function forget(attachment: AnswerAttachment) {
  releaseDraftAttachment(attachment);
  if (attachment.type === "image") URL.revokeObjectURL(attachment.previewUrl);
}

/** Whether an environment takes answer attachments: only uploads can go with an answer. */
export function useAnswerAttachmentSupport(environmentId: EnvironmentId | undefined) {
  const configs = useServerConfigs();
  const capabilities =
    environmentId === undefined ? undefined : configs.get(environmentId)?.environment.capabilities;
  return capabilities?.attachmentUploads === true
    ? { maxFileBytes: capabilities.fileAttachments?.maxUploadBytes ?? null }
    : null;
}

/**
 * The files on each open answer, by the answer's key, uploaded to the asking environment as
 * they are added. An answer that is delivered or removed releases its uploads.
 */
export function useAnswerAttachments() {
  const [byKey, setByKey] = useState<Readonly<Record<string, ReadonlyArray<AnswerAttachment>>>>({});
  const staged = useRef(new Map<string, AnswerAttachment>());
  // oxlint-disable-next-line t3code/react-effect-budget -- releases unsent uploads and previews when the page closes.
  useEffect(() => {
    const live = staged.current;
    return () => live.forEach(forget);
  }, []);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const uploadsByImageId = useAttachmentUploadStore((state) => state.uploadsByImageId);
  const setError = (key: string, error: string | null) =>
    setErrors((current) => (error === null ? without(current, key) : { ...current, [key]: error }));
  const list = (key: string) => byKey[key] ?? NO_ATTACHMENTS;
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
      for (const image of result.attachments) {
        staged.current.set(image.id, image);
        startAttachmentUpload({ environmentId, image });
      }
      setByKey((current) => ({ ...current, [key]: [...list(key), ...result.attachments] }));
    },
    remove: (key: string, id: string) => {
      const attachment = list(key).find((candidate) => candidate.id === id);
      if (attachment !== undefined) {
        staged.current.delete(id);
        forget(attachment);
      }
      setByKey((current) => ({
        ...current,
        [key]: (current[key] ?? []).filter((candidate) => candidate.id !== id),
      }));
    },
    /** The server copied the files into the agent's thread; the uploads are no longer needed. */
    delivered: (key: string) => {
      for (const attachment of list(key)) {
        staged.current.delete(attachment.id);
        forget(attachment);
      }
      setByKey((current) => without(current, key));
      setError(key, null);
    },
    /** The uploaded files to send, or why the answer must wait. */
    ready: (
      key: string,
      environmentId: EnvironmentId,
    ): { readonly attachments: ReadonlyArray<ChatAttachment> } | { readonly blocked: string } => {
      const attachments = list(key);
      if (attachments.length === 0) return { attachments: [] };
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
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<AnswerAttachment>;
  readonly error: string | null;
  readonly onRemove: (id: string) => void;
}) {
  const uploadsByImageId = useAttachmentUploadStore((state) => state.uploadsByImageId);
  if (props.attachments.length === 0 && props.error === null) return null;
  return (
    <div className="flex flex-col gap-2">
      {props.attachments.length > 0 ? (
        <ul aria-label="Attachments" className="flex flex-wrap gap-2">
          {props.attachments.map((attachment) => {
            const upload = uploadsByImageId[attachment.id];
            const status =
              upload?.status === "uploading"
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
                  onClick={() => props.onRemove(attachment.id)}
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
