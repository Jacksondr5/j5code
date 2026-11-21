import type { J5ReadSource, J5ReadSources } from "@t3tools/client-runtime/j5/readSources";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { HumanInboxResponse } from "@t3tools/contracts/j5";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "../../composerDraftStore";
import {
  inboxAnswerDraftId,
  inboxAnswerDrafts,
  inboxAnswerText,
  persistInboxAnswerImages,
  pruneInboxAnswerDrafts,
  setInboxAnswerText,
} from "./inboxAnswerDrafts";

vi.mock("../../lib/attachmentUploadQueue", () => ({ releaseDraftAttachments: vi.fn() }));
const { serializeComposerImages } = vi.hoisted(() => ({ serializeComposerImages: vi.fn() }));
vi.mock("../../components/chat/composerImagePersistence", () => ({ serializeComposerImages }));

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const projectId = ProjectId.make("project-1");
const key = (environmentId: EnvironmentId, exchangeId: string, personId = "owner") =>
  JSON.stringify([environmentId, personId, projectId, exchangeId]);
const answers = () =>
  Object.fromEntries(
    [...inboxAnswerDrafts(useComposerDraftStore.getState().draftsByThreadKey)].map(
      ([itemKey, draft]) => [itemKey, inboxAnswerText(draft)],
    ),
  );

afterEach(async () => {
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  await useComposerDraftStore.persist.clearStorage();
});

it("keeps a half-typed answer and its uploaded file through leaving the page and reloading", async () => {
  vi.useFakeTimers();
  try {
    setInboxAnswerText(key(local, "ask-1"), "Use the staging database");
    useComposerDraftStore.getState().addFiles(inboxAnswerDraftId(key(local, "ask-1")), [
      {
        type: "file",
        id: "file-1",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        file: null,
        uploadedAttachmentId: "upload-1",
        uploadEnvironmentId: local,
      },
    ]);
    await vi.advanceTimersByTimeAsync(300);
    useComposerDraftStore.setState({ draftsByThreadKey: {} });

    await useComposerDraftStore.persist.rehydrate();

    expect(answers()).toEqual({ [key(local, "ask-1")]: "Use the staging database" });
    expect(
      useComposerDraftStore.getState().getComposerDraft(inboxAnswerDraftId(key(local, "ask-1")))
        ?.files,
    ).toMatchObject([{ id: "file-1", uploadedAttachmentId: "upload-1" }]);
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

it("drops answers whose ask a server's read no longer lists, unless kept on the page", () => {
  const source = (
    environmentId: EnvironmentId,
    status: J5ReadSource<HumanInboxResponse>["status"],
    exchangeIds: ReadonlyArray<string>,
  ): J5ReadSource<HumanInboxResponse> => ({
    environmentId,
    environmentLabel: environmentId,
    connected: status === "ready",
    status,
    error: null,
    refreshing: false,
    data: {
      personId: "owner",
      items: exchangeIds.map(
        (exchangeId) => ({ exchangeId, projectId, personId: "owner" }) as never,
      ),
    },
  });
  for (const itemKey of [
    key(local, "open"),
    key(local, "answered"),
    key(local, "kept"),
    key(local, "open", "previous-person"),
    key(remote, "offline-server"),
  ]) {
    setInboxAnswerText(itemKey, "Words");
  }
  const sources: J5ReadSources<HumanInboxResponse> = {
    isReady: true,
    sources: [source(local, "ready", ["open"]), source(remote, "offline", [])],
  };

  pruneInboxAnswerDrafts(sources, new Set([key(local, "kept")]));

  expect(Object.keys(answers()).toSorted()).toEqual(
    [key(local, "open"), key(local, "kept"), key(remote, "offline-server")].toSorted(),
  );
});
