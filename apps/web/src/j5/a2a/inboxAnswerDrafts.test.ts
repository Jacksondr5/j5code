import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "../../composerDraftStore";
import {
  inboxAnswerDraftId,
  persistInboxAnswerImages,
  setInboxAnswerText,
  useInboxAnswerTexts,
} from "./inboxAnswerDrafts";

vi.mock("../../lib/attachmentUploadQueue", () => ({ releaseDraftAttachments: vi.fn() }));
const { serializeComposerImages } = vi.hoisted(() => ({ serializeComposerImages: vi.fn() }));
vi.mock("../../components/chat/composerImagePersistence", () => ({ serializeComposerImages }));

const local = EnvironmentId.make("local");
const projectId = ProjectId.make("project-1");
const key = (environmentId: EnvironmentId, exchangeId: string, personId = "owner") =>
  JSON.stringify([environmentId, personId, projectId, exchangeId]);
const answers = () => useInboxAnswerTexts.getState().byItemKey;

afterEach(async () => {
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  useInboxAnswerTexts.setState({ byItemKey: {} });
  await useComposerDraftStore.persist.clearStorage();
  await useInboxAnswerTexts.persist.clearStorage();
});

it("keeps a half-typed answer exactly, with its uploaded files, through reloads and edits to the files", async () => {
  vi.useFakeTimers();
  const file = (id: string) => ({
    type: "file" as const,
    id,
    name: `${id}.pdf`,
    mimeType: "application/pdf",
    sizeBytes: 10,
    file: null,
    uploadedAttachmentId: `upload-${id}`,
    uploadEnvironmentId: local,
  });
  const reload = async () => {
    await vi.advanceTimersByTimeAsync(300);
    useComposerDraftStore.setState({ draftsByThreadKey: {} });
    useInboxAnswerTexts.setState({ byItemKey: {} });
    await useComposerDraftStore.persist.rehydrate();
    await useInboxAnswerTexts.persist.rehydrate();
    // A real reload starts empty without saving; replace the pending save of the cleared state.
    useInboxAnswerTexts.setState((state) => state);
  };
  const target = inboxAnswerDraftId(key(local, "ask-1"));
  const typed = "Use the [staging database\n  ";
  try {
    setInboxAnswerText(key(local, "ask-1"), typed);
    useComposerDraftStore.getState().addFiles(target, [file("a"), file("b")]);
    await reload();
    // Another answer's files save the whole store, this answer's rehydrated draft included.
    useComposerDraftStore.getState().addFiles(inboxAnswerDraftId(key(local, "ask-2")), [file("c")]);
    await reload();
    useComposerDraftStore.getState().removeFile(target, "a");
    await reload();

    expect(answers()).toEqual({ [key(local, "ask-1")]: typed });
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.files).toMatchObject([
      { id: "b", uploadedAttachmentId: "upload-b" },
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps a newer image save when an older one finishes after it", async () => {
  const itemKey = key(local, "ask-1");
  const target = inboxAnswerDraftId(itemKey);
  const image = (id: string) => ({
    type: "image" as const,
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 1,
    previewUrl: `data:image/png;base64,${id}`,
    file: new File(["x"], `${id}.png`, { type: "image/png" }),
  });
  const saved = (id: string) => ({
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 1,
    dataUrl: `data:image/png;base64,${id}`,
  });
  let finishOlder: (value: ReturnType<typeof saved>[]) => void = () => {};
  serializeComposerImages.mockReturnValueOnce(
    new Promise((resolve) => {
      finishOlder = resolve;
    }),
  );
  serializeComposerImages.mockResolvedValueOnce([saved("a"), saved("b")]);
  let finishThird: (value: ReturnType<typeof saved>[]) => void = () => {};
  serializeComposerImages.mockReturnValueOnce(
    new Promise((resolve) => {
      finishThird = resolve;
    }),
  );
  // The store checks each save against localStorage, which this environment lacks.
  const { syncPersistedAttachments } = useComposerDraftStore.getState();
  const sync = vi.fn(async () => {});
  useComposerDraftStore.setState({ syncPersistedAttachments: sync });
  try {
    useComposerDraftStore.getState().addImages(target, [image("a")]);
    const first = persistInboxAnswerImages(itemKey);
    useComposerDraftStore.getState().addImages(target, [image("b")]);
    await persistInboxAnswerImages(itemKey);
    useComposerDraftStore.getState().addImages(target, [image("c")]);
    const third = persistInboxAnswerImages(itemKey);

    finishOlder([saved("a")]);
    await first;
    finishThird([saved("a"), saved("b"), saved("c")]);
    await third;

    expect(sync.mock.calls).toEqual([
      [target, [saved("a"), saved("b")]],
      [target, [saved("a"), saved("b"), saved("c")]],
    ]);
  } finally {
    useComposerDraftStore.setState({ syncPersistedAttachments });
  }
});
