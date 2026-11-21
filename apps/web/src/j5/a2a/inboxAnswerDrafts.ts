import type { J5ReadSources } from "@t3tools/client-runtime/j5/readSources";
import type { EnvironmentId } from "@t3tools/contracts";
import { type HumanInboxResponse, scopedInboxItemKey } from "@t3tools/contracts/j5";
import { create } from "zustand";
import { persist, type StorageValue } from "zustand/middleware";

import {
  type ComposerThreadDraftState,
  DraftId,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { serializeComposerImages } from "../../components/chat/composerImagePersistence";
import { releaseDraftAttachments } from "../../lib/attachmentUploadQueue";
import { createDeferredStorage, createMemoryStorage } from "../../lib/storage";

// An answer's files are a composer draft of their own, as upstream keeps a pending question's
// attachments, so they outlive the page and a reload the way an unsent message's do.
const PREFIX = "j5-inbox-answer:";

export const inboxAnswerDraftId = (itemKey: string) =>
  DraftId.make(`${PREFIX}${encodeURIComponent(itemKey)}`);

function itemKeyOf(draftKey: string): string | null {
  return draftKey.startsWith(PREFIX) ? decodeURIComponent(draftKey.slice(PREFIX.length)) : null;
}

const environmentOf = (itemKey: string) => (JSON.parse(itemKey) as [EnvironmentId])[0];

/** Every answer's saved files, by its item's `scopedInboxItemKey`. */
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

interface InboxAnswerTexts {
  readonly byItemKey: Readonly<Record<string, string>>;
}

// The words are kept apart from the composer draft: its prompt carries inline file tokens that the
// store adds, rewrites and removes, and an answer is delivered exactly as typed.
const textStorage = createDeferredStorage<StorageValue<InboxAnswerTexts>>(
  typeof localStorage !== "undefined" ? localStorage : createMemoryStorage(),
  (value) => JSON.stringify(value),
);
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => textStorage.flush());
}

/** Each open answer's words, by its item's `scopedInboxItemKey`. */
export const useInboxAnswerTexts = create<InboxAnswerTexts>()(
  persist(() => ({ byItemKey: {} }), {
    name: "j5:inbox-answer-texts:v1",
    storage: {
      getItem: (name) => {
        const raw = textStorage.getItem(name);
        return typeof raw === "string" ? (JSON.parse(raw) as StorageValue<InboxAnswerTexts>) : null;
      },
      setItem: (name, value) => textStorage.setItem(name, value),
      removeItem: (name) => textStorage.removeItem(name),
    },
  }),
);

function withoutText(itemKey: string) {
  useInboxAnswerTexts.setState(({ byItemKey }) => {
    if (!(itemKey in byItemKey)) return {};
    const rest = { ...byItemKey };
    delete rest[itemKey];
    return { byItemKey: rest };
  });
}

export function setInboxAnswerText(itemKey: string, text: string) {
  if (text === "") withoutText(itemKey);
  else
    useInboxAnswerTexts.setState(({ byItemKey }) => ({
      byItemKey: { ...byItemKey, [itemKey]: text },
    }));
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
  withoutText(itemKey);
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
  const itemKeys = new Set([
    ...inboxAnswerDrafts(useComposerDraftStore.getState().draftsByThreadKey).keys(),
    ...Object.keys(useInboxAnswerTexts.getState().byItemKey),
  ]);
  for (const itemKey of itemKeys) {
    const open = openByEnvironment.get(environmentOf(itemKey));
    if (open !== undefined && !open.has(itemKey) && !kept.has(itemKey)) {
      clearInboxAnswerDraft(itemKey);
    }
  }
}
