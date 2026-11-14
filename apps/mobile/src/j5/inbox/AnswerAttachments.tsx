import { answerAttachmentSupport } from "@t3tools/client-runtime/j5/inbox";
import { type EnvironmentId, PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { TextInputWrapper } from "expo-paste-input";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import * as Dialog from "../../components/ui/Dialog";
import { ComposerAttachmentButton } from "../../features/threads/ComposerAttachmentButton";
import {
  convertPastedImagesToAttachments,
  type DraftComposerAttachment,
  pickComposerFiles,
  pickComposerMedia,
} from "../../lib/composerImages";
import { useNativePaste } from "../../lib/useNativePaste";
import { appAtomRegistry } from "../../state/atom-registry";
import { useServerConfigs } from "../../state/entities";
import {
  appendComposerDraftAttachments,
  composerDraftsAtom,
  releaseUnusedComposerAttachmentFiles,
  removeComposerDraftAttachment,
} from "../../state/use-composer-drafts";
import {
  answerAttachmentDraftKey,
  type AnswerTarget,
  useAnswerDraftAttachments,
} from "./answerAttachmentDrafts";

function useAnswerSupport(environmentId: EnvironmentId) {
  return answerAttachmentSupport(useServerConfigs().get(environmentId)?.environment.capabilities);
}

/** Whether the component is still mounted when a picker or paste resolves. */
function useMounted() {
  const mounted = useRef(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a picked file that arrives after the answer closed is released rather than kept in a draft nobody sends.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

function attach(target: AnswerTarget, picked: ReadonlyArray<DraftComposerAttachment>) {
  return appendComposerDraftAttachments(answerAttachmentDraftKey(target), picked, {
    maxAttachments: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  });
}

function existingCount(target: AnswerTarget) {
  return (
    appAtomRegistry.get(composerDraftsAtom)[answerAttachmentDraftKey(target)]?.attachments.length ??
    0
  );
}

/** The composer's attach button for an answer: photos, and files where the server takes them. */
export function AnswerAttachButton(props: {
  readonly target: AnswerTarget;
  readonly disabled: boolean;
}) {
  const support = useAnswerSupport(props.target.environmentId);
  const mounted = useMounted();
  if (support === null) return null;
  const pick = async (kind: "media" | "files") => {
    const result =
      kind === "files"
        ? await pickComposerFiles({
            existingCount: existingCount(props.target),
            ...(support.maxFileBytes === null ? {} : { maxBytes: support.maxFileBytes }),
          })
        : await pickComposerMedia({
            existingCount: existingCount(props.target),
            ...(support.maxFileBytes === null ? {} : { maxVideoBytes: support.maxFileBytes }),
          });
    const picked = "files" in result ? result.files : result.attachments;
    if (!mounted.current) {
      await releaseUnusedComposerAttachmentFiles(picked);
      return;
    }
    const rejected = attach(props.target, picked);
    if (result.error || rejected > 0) {
      Dialog.alert("Could not attach file", result.error ?? "Too many attachments.");
    }
  };
  return (
    <ComposerAttachmentButton
      disabled={props.disabled}
      supportsFiles={support.maxFileBytes !== null}
      onPickMedia={() => pick("media")}
      onPickFiles={() => pick("files")}
    />
  );
}

/** Wraps an answer box so pasted images become the answer's attachments. */
export function AnswerPasteTarget(props: {
  readonly target: AnswerTarget;
  readonly disabled: boolean;
  readonly children: ReactNode;
}) {
  const { target, disabled } = props;
  const support = useAnswerSupport(target.environmentId);
  const mounted = useMounted();
  const paste = useNativePaste((uris) => {
    if (disabled || support === null) return;
    void convertPastedImagesToAttachments({ uris, existingCount: existingCount(target) })
      .then(async (images) => {
        if (!mounted.current) {
          await releaseUnusedComposerAttachmentFiles(images);
          return;
        }
        if (attach(target, images) > 0) {
          Dialog.alert("Could not paste image", "Too many attachments.");
        }
      })
      .catch((error: unknown) =>
        Dialog.alert(
          "Could not paste image",
          error instanceof Error ? error.message : "Try again.",
        ),
      );
  });
  return <TextInputWrapper onPaste={paste}>{props.children}</TextInputWrapper>;
}

/** The answer's attachments, each showing its upload, with a way to remove it. */
export function AnswerAttachmentStrip(props: {
  readonly target: AnswerTarget;
  readonly disabled: boolean;
}) {
  const attachments = useAnswerDraftAttachments(props.target);
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  if (attachments.length === 0) return null;
  return (
    <>
      <ComposerAttachmentStrip
        environmentId={props.target.environmentId}
        attachments={attachments}
        imageSize={56}
        imageBorderRadius={12}
        onRemove={(id) => {
          if (!props.disabled)
            removeComposerDraftAttachment(answerAttachmentDraftKey(props.target), id);
        }}
        onPressPreview={setPreview}
      />
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
    </>
  );
}
