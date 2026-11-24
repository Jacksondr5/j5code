import { msg, T, useMessages } from "gt-react";
import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  respondToConfirmDialog,
  subscribeConfirmDialogHost,
} from "../confirmDialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogAction,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { m as resolveMessage, type MessageResolver } from "../i18n/messages";

type ConfirmationCopy = {
  readonly title: string;
  readonly description: string | null;
};

// LocalApi.confirm takes one string; translated questions may end in a full-width mark.
const QUESTION_MARK = /[?？]/;

// J5: a caller's own action label, e.g. "Archive anyway" (FORK.md case 22).
export const resolveConfirmDialogActionLabel = (
  confirmLabel?: string,
  resolve: MessageResolver = resolveMessage,
) => confirmLabel ?? resolve(msg("Confirm"));

export function resolveConfirmDialogCopy(
  message: string,
  resolve: MessageResolver = resolveMessage,
): ConfirmationCopy {
  const normalizedMessage = message.trim();
  const lines = normalizedMessage.split("\n");
  const questionLineIndex = lines.findIndex((line) => QUESTION_MARK.test(line.trim().slice(-1)));

  if (questionLineIndex >= 0) {
    const title = lines[questionLineIndex]!.trim();
    const description = lines
      .filter((_, index) => index !== questionLineIndex)
      .join("\n")
      .trim();
    return { title, description: description || null };
  }

  const questionMarkIndex = normalizedMessage.search(QUESTION_MARK);
  if (questionMarkIndex >= 0) {
    return {
      title: normalizedMessage.slice(0, questionMarkIndex + 1).trim(),
      description: normalizedMessage.slice(questionMarkIndex + 1).trim() || null,
    };
  }

  return {
    title: resolve(msg("Confirm action")),
    description: normalizedMessage || resolve(msg("This action requires your confirmation.")),
  };
}

export function ConfirmationDescription({
  message,
  content,
}: {
  readonly message: string;
  readonly content?: ReactNode;
}) {
  if (content !== undefined) {
    return content;
  }
  return resolveConfirmDialogCopy(message).description;
}

export function ConfirmDialogHost() {
  const m = useMessages();
  const state = useSyncExternalStore(
    subscribeConfirmDialogHost,
    readConfirmDialogState,
    readConfirmDialogState,
  );

  const message = state.status === "idle" ? "" : state.message;
  const copy = resolveConfirmDialogCopy(message, m);
  const content = state.status === "idle" ? undefined : state.content;
  const description = <ConfirmationDescription content={content} message={message} />;
  const confirmVariant = state.status === "idle" ? "default" : state.variant;
  const focusConfirm = state.status !== "idle" && state.initialFocus === "confirm";
  const confirmLabel = resolveConfirmDialogActionLabel(
    state.status === "idle" ? undefined : state.confirmLabel,
    m,
  );
  const onCancel = () => respondToConfirmDialog(false);
  const onConfirm = () => respondToConfirmDialog(true);

  return (
    <AlertDialog
      open={state.status === "confirming"}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) completeConfirmDialogClose();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          {content !== undefined ? (
            <AlertDialogDescription render={<div className="text-muted-foreground text-sm" />}>
              {description}
            </AlertDialogDescription>
          ) : copy.description ? (
            <AlertDialogDescription className="whitespace-pre-line">
              {description}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>
            <T>Cancel</T>
          </AlertDialogClose>
          {focusConfirm && confirmVariant === "default" ? (
            <AlertDialogAction onClick={onConfirm}>{confirmLabel}</AlertDialogAction>
          ) : (
            <Button variant={confirmVariant} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
