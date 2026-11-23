import { useAtomValue } from "@effect/atom-react";
import { closedInboxAnswerKeys } from "@t3tools/client-runtime/j5/inbox";
import type { J5ReadSources } from "@t3tools/client-runtime/j5/readSources";
import type { HumanInboxResponse } from "@t3tools/contracts/j5";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";
import { questionAttachmentPreparationAtom } from "../../state/question-attachments";
import {
  clearComposerDraft,
  composerDraftsAtom,
  composerDraftsLoadedAtom,
  ensureComposerDraftsLoaded,
  setComposerDraftText,
} from "../../state/use-composer-drafts";
import {
  answerAttachmentDraftKey,
  answerDraftItemKey,
  type AnswerTarget,
} from "./answerAttachments.logic";

/** Drops an answer's draft, words and files, and any pick still turning into one. */
export function clearAnswerDraft(target: AnswerTarget) {
  clearAnswerDraftKey(answerAttachmentDraftKey(target));
}

function clearAnswerDraftKey(key: string) {
  clearComposerDraft(key);
  const { [key]: _dropped, ...rest } = appAtomRegistry.get(questionAttachmentPreparationAtom);
  appAtomRegistry.set(questionAttachmentPreparationAtom, rest);
}

const NO_ANSWER_TEXTS: Readonly<Record<string, string>> = {};

const sameTexts = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

// Equal while the words are, so a keystroke in another composer does not redraw the answers.
const answerTextsAtom = Atom.make((get) => {
  const texts: Record<string, string> = {};
  for (const [draftKey, draft] of Object.entries(get(composerDraftsAtom))) {
    if (draft.text === "") continue;
    const itemKey = answerDraftItemKey(draftKey);
    if (itemKey !== null) texts[itemKey] = draft.text;
  }
  return Object.keys(texts).length === 0 ? NO_ANSWER_TEXTS : texts;
}).pipe(Atom.withEquality(sameTexts));

/** Each answer's words, by its ask's `scopedInboxItemKey`. */
export function useAnswerTexts(): Readonly<Record<string, string>> {
  ensureComposerDraftsLoaded();
  return useAtomValue(answerTextsAtom);
}

/** Whether saved drafts have been read back, so pruning sees the ones a restart restores. */
export const useAnswerDraftsLoaded = () => useAtomValue(composerDraftsLoadedAtom);

export function setAnswerText(target: AnswerTarget, text: string) {
  setComposerDraftText(answerAttachmentDraftKey(target), text);
}

/** Drops the answers to asks that closed, as `closedInboxAnswerKeys` decides. */
export function pruneAnswerDrafts(
  openSources: J5ReadSources<HumanInboxResponse>,
  kept: ReadonlySet<string>,
) {
  const draftKeys = new Map<string, string>();
  for (const draftKey of Object.keys(appAtomRegistry.get(composerDraftsAtom))) {
    const itemKey = answerDraftItemKey(draftKey);
    if (itemKey !== null) draftKeys.set(itemKey, draftKey);
  }
  for (const itemKey of closedInboxAnswerKeys({ openSources, itemKeys: draftKeys.keys(), kept })) {
    const draftKey = draftKeys.get(itemKey);
    if (draftKey !== undefined) clearAnswerDraftKey(draftKey);
  }
}
