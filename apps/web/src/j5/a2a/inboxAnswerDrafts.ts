import type { J5ReadSources } from "@t3tools/client-runtime/j5/readSources";
import type { EnvironmentId } from "@t3tools/contracts";
import { type HumanInboxResponse, scopedInboxItemKey } from "@t3tools/contracts/j5";

import {
  type ComposerThreadDraftState,
  DraftId,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { serializeComposerImages } from "../../components/chat/composerImagePersistence";
import { releaseDraftAttachments } from "../../lib/attachmentUploadQueue";
import { removeInlineContextReference } from "../../lib/composerContextReferences";
import { toKindScopedComposerContextId } from "@t3tools/shared/composerContextReferences";

// Each answer is a composer draft of its own, as upstream keeps a pending question's attachments,
// so its words and files outlive the page and a reload the way an unsent message does.
const PREFIX = "j5-inbox-answer:";

export const inboxAnswerDraftId = (itemKey: string) =>
  DraftId.make(`${PREFIX}${encodeURIComponent(itemKey)}`);

function itemKeyOf(draftKey: string): string | null {
  return draftKey.startsWith(PREFIX) ? decodeURIComponent(draftKey.slice(PREFIX.length)) : null;
}

const environmentOf = (itemKey: string) => (JSON.parse(itemKey) as [EnvironmentId])[0];

/** Every saved answer, by its item's `scopedInboxItemKey`. */
export function inboxAnswerDrafts(
  draftsByThreadKey: Readonly<Record<string, ComposerThreadDraftState>>,
): ReadonlyMap<string, ComposerThreadDraftState> {
  const drafts = new Map<string, ComposerThreadDraftState>();
  for (const [draftKey, draft] of Object.entries(draftsByThreadKey)) {
    const itemKey = itemKeyOf(draftKey);
    if (itemKey !== null) drafts.set(itemKey, draft);
  }
  return drafts;
}

/**
 * The answer as typed. Rehydrating a draft appends a reference token for each file, which the
 * composer wants and an answer, delivered word for word, must not carry.
 */
export function inboxAnswerText(draft: ComposerThreadDraftState): string {
  let text = draft.prompt;
  for (const file of draft.files) {
    text = removeInlineContextReference(
      text,
      toKindScopedComposerContextId("file", file.id),
    ).prompt;
  }
  return text;
}

export function setInboxAnswerText(itemKey: string, text: string) {
  useComposerDraftStore.getState().setPrompt(inboxAnswerDraftId(itemKey), text);
}

const latestImageSave = new Map<string, number>();

/** Saves the answer's images as data URLs, as the composer does, so a reload brings them back. */
export async function persistInboxAnswerImages(itemKey: string) {
  const target = inboxAnswerDraftId(itemKey);
  const read = () => useComposerDraftStore.getState().getComposerDraft(target);
  const draft = read();
  if (draft === null) return;
  const save = (latestImageSave.get(itemKey) ?? 0) + 1;
  latestImageSave.set(itemKey, save);
  const serialized = await serializeComposerImages(draft.images, draft.persistedAttachments);
  // A later save saw more images; this one's list would drop them.
  if (latestImageSave.get(itemKey) !== save) return;
  const current = new Set((read()?.images ?? []).map((image) => image.id));
  await useComposerDraftStore.getState().syncPersistedAttachments(
    target,
    serialized.filter((attachment) => current.has(attachment.id)),
  );
}

/** Drops an answer's words and releases its uploads. */
export function clearInboxAnswerDraft(itemKey: string) {
  const target = inboxAnswerDraftId(itemKey);
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(target);
  if (draft === null) return;
  releaseDraftAttachments([...draft.images, ...draft.files]);
  for (const image of draft.images) {
    if (image.previewUrl.startsWith("blob:")) URL.revokeObjectURL(image.previewUrl);
  }
  store.clearComposerContent(target);
}

/**
 * Drops the answers to asks a server's latest read no longer lists for this person: answered,
 * withdrawn, or asked of someone else. An ask kept on the page with its words (AC17) keeps them.
 */
export function pruneInboxAnswerDrafts(
  openSources: J5ReadSources<HumanInboxResponse>,
  kept: ReadonlySet<string>,
) {
  const openByEnvironment = new Map<EnvironmentId, ReadonlySet<string>>();
  for (const source of openSources.sources) {
    if (source.status !== "ready" || source.data === null) continue;
    const { environmentId } = source;
    openByEnvironment.set(
      environmentId,
      new Set(source.data.items.map((item) => scopedInboxItemKey({ ...item, environmentId }))),
    );
  }
  const drafts = inboxAnswerDrafts(useComposerDraftStore.getState().draftsByThreadKey);
  for (const itemKey of drafts.keys()) {
    const open = openByEnvironment.get(environmentOf(itemKey));
    if (open !== undefined && !open.has(itemKey) && !kept.has(itemKey)) {
      clearInboxAnswerDraft(itemKey);
    }
  }
}
