import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { useComposerDraftStore } from "../../composerDraftStore";
import { AnswerAttachmentList } from "./AnswerAttachments";
import { inboxAnswerDraftId } from "./inboxAnswerDrafts";

it("marks the images a full localStorage couldn't save with the composer's warning", async () => {
  const environmentId = EnvironmentId.make("env-inbox");
  const answerKey = JSON.stringify([environmentId, "owner", "project-1", "ask-1"]);
  const target = inboxAnswerDraftId(answerKey);
  const image = (id: string) => ({
    type: "image" as const,
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 1,
    previewUrl: "data:image/png;base64,iVBORw0KGgo=",
    file: new File(["x"], `${id}.png`, { type: "image/png" }),
  });
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  useComposerDraftStore.getState().addImages(target, [image("kept"), image("lost")]);
  useComposerDraftStore.setState(({ draftsByThreadKey }) => ({
    draftsByThreadKey: {
      ...draftsByThreadKey,
      [target]: { ...draftsByThreadKey[target]!, nonPersistedImageIds: ["lost"] },
    },
  }));

  await using screen = await render(
    <AnswerAttachmentList
      answerKey={answerKey}
      attachments={useComposerDraftStore.getState().draftsByThreadKey[target]!.images}
      environmentId={environmentId}
      error={null}
      onRemove={() => {}}
    />,
  );

  const warning = { name: "Draft attachment may not persist" };
  const tile = (name: string) => screen.getByRole("listitem").filter({ hasText: name });
  await expect.element(tile("lost.png").getByRole("img", warning)).toBeVisible();
  await expect.element(tile("kept.png").getByRole("img", warning)).not.toBeInTheDocument();
});
