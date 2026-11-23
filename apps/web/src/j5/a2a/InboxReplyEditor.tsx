import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { composerSubmissionIntentForKey } from "../../composer-logic";
import { EMPTY_COMPOSER_CONTEXT_RECORDS } from "../../components/composerContextPresentation";
import {
  type ComposerPromptEditorHandle,
  ComposerPromptEditorTiptap,
} from "../../components/ComposerPromptEditorTiptap";
import { useSoftwareKeyboardOpen } from "../../hooks/useSoftwareKeyboardOpen";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { primaryServerKeybindingsAtom } from "../../state/server";

const NO_SKILLS: never[] = [];
const noPaste = () => undefined;

/**
 * An Inbox answer typed in the composer's editor, in the exact-text mode upstream uses for its own
 * question answers, so it is delivered word for word. Enter sends as the send-shortcut setting
 * says; no `@`, `$` or `/` pickers.
 */
export function InboxReplyEditor(props: {
  readonly environmentId: EnvironmentId;
  /** One editor per ask: a new key starts a fresh one. */
  readonly draftKey: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  /** Shows the words but takes no input: a read-only connection or a closed ask. */
  readonly readOnly: boolean;
  readonly ariaLabel: string;
  readonly placeholder: string;
  readonly editorRef: React.RefObject<ComposerPromptEditorHandle | null>;
  readonly onPaste?: React.ClipboardEventHandler<HTMLElement> | undefined;
  readonly className?: string;
}) {
  const sendShortcut = useEnvironmentSettings(props.environmentId, (s) => s.sendShortcut);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const isSoftwareKeyboardOpen = useSoftwareKeyboardOpen();
  const [cursor, setCursor] = useState(props.value.length);
  return (
    <div
      className={cn(
        // The page's input frame, around the composer's own editor.
        "rounded-lg border border-input bg-background px-3 py-2 shadow-xs/5 ring-ring/24 transition-shadow has-focus-visible:border-ring has-focus-visible:ring-3 has-focus-visible:ring-inset dark:bg-input/32",
        props.readOnly && "bg-muted/40",
        props.className,
      )}
    >
      <ComposerPromptEditorTiptap
        ariaLabel={props.ariaLabel}
        contextRecords={EMPTY_COMPOSER_CONTEXT_RECORDS}
        cursor={Math.min(cursor, props.value.length)}
        disabled={props.readOnly}
        draftKey={props.draftKey}
        editorRef={props.editorRef}
        literalText
        onChange={(value, nextCursor) => {
          setCursor(nextCursor);
          props.onChange(value);
        }}
        onCommandKeyDown={(_key, event) => {
          const intent = composerSubmissionIntentForKey({
            event,
            keybindings,
            isSoftwareKeyboardOpen,
            isDraftThread: false,
            sendShortcut,
            prompt: props.value,
          });
          if (intent !== "foreground") return false;
          props.onSubmit();
          return true;
        }}
        onPaste={props.onPaste ?? noPaste}
        placeholder={props.placeholder}
        skills={NO_SKILLS}
        value={props.value}
      />
    </div>
  );
}
