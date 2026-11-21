import type { J5ReadSource, J5ReadSources } from "@t3tools/client-runtime/j5/readSources";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { HumanInboxResponse } from "@t3tools/contracts/j5";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "../../composerDraftStore";
import { inboxAnswerDrafts, pruneInboxAnswerDrafts, setInboxAnswerText } from "./inboxAnswerDrafts";

vi.mock("../../lib/attachmentUploadQueue", () => ({ releaseDraftAttachments: vi.fn() }));

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const projectId = ProjectId.make("project-1");
const key = (environmentId: EnvironmentId, exchangeId: string, personId = "owner") =>
  JSON.stringify([environmentId, personId, projectId, exchangeId]);
const answers = () =>
  Object.fromEntries(
    [...inboxAnswerDrafts(useComposerDraftStore.getState().draftsByThreadKey)].map(
      ([itemKey, draft]) => [itemKey, draft.prompt],
    ),
  );

afterEach(async () => {
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  await useComposerDraftStore.persist.clearStorage();
});

it("keeps a half-typed answer through leaving the page and reloading", async () => {
  vi.useFakeTimers();
  try {
    setInboxAnswerText(key(local, "ask-1"), "Use the staging database");
    await vi.advanceTimersByTimeAsync(300);
    useComposerDraftStore.setState({ draftsByThreadKey: {} });

    await useComposerDraftStore.persist.rehydrate();

    expect(answers()).toEqual({ [key(local, "ask-1")]: "Use the staging database" });
  } finally {
    vi.useRealTimers();
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
