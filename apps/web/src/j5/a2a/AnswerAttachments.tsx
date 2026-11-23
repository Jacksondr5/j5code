import { type ChatAttachment, type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { answerAttachmentSupport } from "@t3tools/client-runtime/j5/inbox";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import { useEffect, useState } from "react";

import {
  ComposerAttachButton,
  ComposerAttachmentFileList,
  ComposerAttachmentMediaRow,
  ComposerFilePreviewDialog,
} from "../../components/chat/ComposerAttachmentStrip";
import {
  composerOtherFilesForPresentation,
  isPreviewableComposerVideo,
  shouldHandleComposerAttachmentPaste,
} from "../../components/chat/composerAttachmentFiles";
import {
  ExpandedImageDialogHost,
  openExpandedImagePreview,
} from "../../components/chat/ExpandedImageDialog";
import { usePreparingComposerImages } from "../../components/chat/preparingComposerImages";
import { useComposerAttachmentIntake } from "../../components/chat/useComposerAttachmentIntake";
import { splitTransferredFiles } from "../../components/chat/workspaceFileDrop";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  composerFileNeedsReattach,
  composerTargetKey,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { useRenderedAppearance } from "../../hooks/useTheme";
import {
  getUploadedAttachments,
  releaseAttachmentUpload,
  releaseDraftAttachment,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "../../lib/attachmentUploadQueue";
import { attachmentUploadBlockReason } from "../../lib/attachmentUploadState";
import { useServerConfigs } from "../../state/entities";
import {
  clearInboxAnswerDraft,
  inboxAnswerDraftId,
  inboxAnswerDrafts,
  persistInboxAnswerImages,
} from "./inboxAnswerDrafts";

type AnswerAttachment = ComposerImageAttachment | ComposerFileAttachment;
export type AnswerAttachmentSupport = ReturnType<typeof answerAttachmentSupport>;

const NO_ATTACHMENTS: ReadonlyArray<AnswerAttachment> = [];
const NO_IMAGES: ReadonlyArray<ComposerImageAttachment> = [];
const NO_FILES: ReadonlyArray<ComposerFileAttachment> = [];
const NO_IDS: ReadonlyArray<string> = [];
const NO_INLINE_FILES: ReadonlySet<string> = new Set();
const NO_PENDING_INPUTS: never[] = [];

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
 * Uploads an answer's files to the asking environment, as the composer uploads its draft's: the
 * ones just added, and after a reload the ones restored from the saved draft, since the queue lives
 * in memory and refuses to start before the environment's grant arrives.
 */
export function useAnswerUploads(
  key: string,
  environmentId: EnvironmentId | undefined,
  mayAnswer: boolean,
) {
  const target = inboxAnswerDraftId(key);
  const draft = useComposerDraftStore((state) => state.draftsByThreadKey[target]);
  const supported = useAnswerAttachmentSupport(environmentId) !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the in-memory upload queue for the draft's files as they arrive or are restored; repeat calls are no-ops.
  useEffect(() => {
    if (!mayAnswer || !supported || draft === undefined || environmentId === undefined) return;
    for (const attachment of [...draft.images, ...draft.files]) {
      if (needsReattach(attachment)) continue;
      startAttachmentUpload({ environmentId, image: attachment, draftTarget: target });
    }
  }, [mayAnswer, supported, draft, environmentId, target]);
}

/**
 * The files on each open answer, by the answer's key, kept in its saved draft. An answer that is
 * delivered or removed releases them.
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
    setError,
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
      if (lost !== undefined) return { blocked: `Attach ${lost.name} again or remove it.` };
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

/** A live view of the answer's draft, read when the intake asks rather than when it rendered. */
function draftRef<T>(read: () => T): { readonly current: T } {
  return {
    get current() {
      return read();
    },
  };
}

/**
 * Takes files into one answer the way the composer takes them into a message: each file is
 * checked on its own so one bad file leaves the rest, HEIC is converted, large images are shrunk,
 * empty files are refused, and a file lost after a reload is attached again in its place.
 */
export function useAnswerAttachmentIntake(input: {
  readonly answerKey: string;
  readonly support: AnswerAttachmentSupport;
  readonly onError: (error: string | null) => void;
}) {
  const target = inboxAnswerDraftId(input.answerKey);
  const targetKey = composerTargetKey(target);
  const preparing = usePreparingComposerImages(targetKey);
  const read = () => useComposerDraftStore.getState().getComposerDraft(target);
  const addImages = (images: ComposerImageAttachment[]) => {
    const stored = useComposerDraftStore.getState().addImages(target, images);
    if (stored.length > 0) void persistInboxAnswerImages(input.answerKey);
    return stored;
  };
  const maxFileBytes = input.support?.maxFileBytes ?? null;
  const intake = useComposerAttachmentIntake({
    // Only a guard and an error's address in the composer; the answer reports its own errors.
    activeThreadId: ThreadId.make(targetKey),
    activePendingProgress: null,
    activePendingIsResponding: false,
    pendingUserInputs: NO_PENDING_INPUTS,
    supportsQuestionAttachments: true,
    // An answer is delivered as typed, so a long paste stays text.
    isLiteralPendingAnswer: true,
    projectSelectionRequired: false,
    questionAttachmentTarget: null,
    attachmentTargetKey: targetKey,
    fileStagingLimit: maxFileBytes === null ? null : clampFileAttachmentUploadBytes(maxFileBytes),
    promptRef: draftRef(() => ""),
    composerImagesRef: draftRef(() => [...(read()?.images ?? NO_IMAGES)]),
    composerFilesRef: draftRef(() => [...(read()?.files ?? NO_FILES)]),
    composerEditorRef: draftRef(() => null),
    isRevertingCheckpointRef: draftRef(() => false),
    setThreadError: (_threadId, error) => input.onError(error),
    countReservedAttachments: () =>
      (read()?.images.length ?? 0) + (read()?.files.length ?? 0) + preparing.length,
    addComposerImage: (image) => addImages([image]),
    addComposerImagesToDraft: addImages,
    addComposerFilesToDraft: (files) =>
      useComposerDraftStore.getState().addFiles(target, files, { appendReference: false }),
    removeComposerImageFromDraft: (imageId) => {
      releaseAttachmentUpload(imageId);
      useComposerDraftStore.getState().removeImage(target, imageId);
    },
    // An answer carries no inline chips; its files go beside the words.
    insertAttachmentReferences: () => false,
  });
  return {
    addFiles: (files: ReadonlyArray<File>) => void intake.addComposerAttachments([...files]),
    removeImage: intake.removeComposerImage,
    removeFile: (fileId: string) => {
      const file = read()?.files.find((candidate) => candidate.id === fileId);
      if (file === undefined) return;
      releaseDraftAttachment(file);
      useComposerDraftStore.getState().removeFile(target, fileId);
    },
  };
}

export type AnswerAttachmentIntake = ReturnType<typeof useAnswerAttachmentIntake>;

/** Paste and drop handlers that turn files into attachments and leave plain text alone. */
export function answerAttachmentInputHandlers(
  onFiles: (files: ReadonlyArray<File>) => void,
  setDragActive: (active: boolean) => void,
) {
  const isFileDrag = (event: React.DragEvent<HTMLElement>) =>
    event.dataTransfer.types.includes("Files");
  return {
    onPaste: (event: React.ClipboardEvent<HTMLElement>) => {
      const files = Array.from(event.clipboardData.files);
      const plainText = event.clipboardData.getData("text/plain");
      if (files.length === 0 || !shouldHandleComposerAttachmentPaste({ files, plainText })) return;
      event.preventDefault();
      onFiles(files);
    },
    onDragEnter: (event: React.DragEvent<HTMLElement>) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      setDragActive(true);
    },
    onDragOver: (event: React.DragEvent<HTMLElement>) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (event: React.DragEvent<HTMLElement>) => {
      if (!isFileDrag(event)) return;
      // Moving onto a child of the reply is not leaving it.
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))
        return;
      setDragActive(false);
    },
    onDrop: (event: React.DragEvent<HTMLElement>) => {
      setDragActive(false);
      // Folders are not files an answer can carry, as in the composer's own drop.
      const { files } = splitTransferredFiles(event.dataTransfer);
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

/**
 * The composer's attachment strip under an answer: image and video tiles that open in the image
 * viewer, file rows that open a preview, upload progress and retry with the reason, re-attach in
 * place, and the warning on an image that a reload would lose.
 */
export function AnswerAttachmentStrip(props: {
  readonly answerKey: string;
  readonly environmentId: EnvironmentId;
  readonly support: AnswerAttachmentSupport;
  readonly intake: AnswerAttachmentIntake;
  readonly error: string | null;
  /** While the answer is being delivered the server is claiming these uploads. */
  readonly delivering: boolean;
}) {
  const target = inboxAnswerDraftId(props.answerKey);
  const draft = useComposerDraftStore((state) => state.draftsByThreadKey[target]);
  const preparing = usePreparingComposerImages(composerTargetKey(target));
  const resolvedTheme = useRenderedAppearance();
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);
  const images = draft?.images ?? NO_IMAGES;
  const files = draft?.files ?? NO_FILES;
  const videos = files.filter((file) => isPreviewableComposerVideo(file, props.environmentId));
  const otherFiles = composerOtherFilesForPresentation(files, props.environmentId, NO_INLINE_FILES);
  const previewFile = files.find((file) => file.id === previewFileId);
  const maxFileBytes = props.support?.maxFileBytes ?? null;
  const viewerKey = `j5-answer:${props.answerKey}`;
  const removeImage = (id: string) => {
    if (!props.delivering) props.intake.removeImage(id);
  };
  const removeFile = (id: string) => {
    if (!props.delivering) props.intake.removeFile(id);
  };
  const common = {
    supportsAttachmentUploads: props.support !== null,
    maxFileAttachmentBytes: maxFileBytes,
    environmentId: props.environmentId,
    attachmentDraftTarget: target,
    canOperateThread: !props.delivering,
  };
  if (images.length + files.length + preparing.length === 0 && props.error === null) return null;
  return (
    <div className="flex flex-col">
      {images.length + videos.length + preparing.length > 0 ? (
        <ComposerAttachmentMediaRow
          {...common}
          images={images}
          expandedImages={images}
          preparingImages={preparing}
          videos={videos}
          pendingSnapShotAnimations={[]}
          pendingSnapShotIds={NO_IDS}
          uncommittedSnapShotIds={NO_IDS}
          nonPersistedImageIds={draft?.nonPersistedImageIds ?? NO_IDS}
          snapShotAnimations={false}
          onExpandImage={(preview) => openExpandedImagePreview(viewerKey, preview)}
          // A video's file is gone after a reload until it is attached again.
          onFileOpen={() => undefined}
          onRemoveImage={removeImage}
          onRemoveFile={removeFile}
        />
      ) : null}
      {otherFiles.length > 0 ? (
        <ComposerAttachmentFileList
          {...common}
          files={otherFiles}
          resolvedTheme={resolvedTheme}
          fileStagingLimit={
            maxFileBytes === null ? null : clampFileAttachmentUploadBytes(maxFileBytes)
          }
          onPreviewFile={setPreviewFileId}
          onRemoveFile={removeFile}
        />
      ) : null}
      {previewFile ? (
        <ComposerFilePreviewDialog
          file={previewFile}
          onRemove={removeFile}
          onPreviewFileIdChange={setPreviewFileId}
        />
      ) : null}
      <ExpandedImageDialogHost threadKey={viewerKey} />
      {props.error === null ? null : (
        <p className="text-sm text-destructive" role="alert">
          {props.error}
        </p>
      )}
    </div>
  );
}
