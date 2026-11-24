import type { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { composerTargetKey, useComposerDraftStore } from "../../composerDraftStore";
import {
  addPreparingComposerImages,
  removePreparingComposerImages,
} from "../../components/chat/preparingComposerImages";
import {
  AnswerAttachmentStrip,
  useAnswerAttachmentIntake,
  useAnswerAttachments,
} from "./AnswerAttachments";
import { inboxAnswerDraftId } from "./inboxAnswerDrafts";

const environmentId = "env-answer" as EnvironmentId;
const answerKey = "env-answer:exchange-1";
const target = inboxAnswerDraftId(answerKey);
const support = { maxFileBytes: 1_000_000 };

function setup() {
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  const errors: Array<string | null> = [];
  return { errors };
}

const draft = () => useComposerDraftStore.getState().draftsByThreadKey[composerTargetKey(target)];

function Answer(props: { readonly onError: (error: string | null) => void }) {
  const intake = useAnswerAttachmentIntake({ answerKey, support, onError: props.onError });
  return (
    <>
      <input
        aria-label="Files"
        multiple
        onChange={(event) => intake.addFiles(Array.from(event.currentTarget.files ?? []))}
        type="file"
      />
      <AnswerAttachmentStrip
        answerKey={answerKey}
        delivering={false}
        environmentId={environmentId}
        error={null}
        intake={intake}
        support={support}
      />
    </>
  );
}

it("takes each file in a batch on its own, and puts a re-picked file back in its place", async () => {
  const { errors } = setup();
  // A file restored after a reload: its name and size are kept, its contents are not.
  useComposerDraftStore.getState().addFiles(
    target,
    [
      {
        type: "file",
        id: "lost",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        file: null,
      },
    ],
    { appendReference: false },
  );
  await using screen = await render(<Answer onError={(error) => errors.push(error)} />, {
    router: false, // The strip reads no route.
  });

  await screen
    .getByLabelText("Files")
    .upload([
      new File([], "empty.txt", { type: "text/plain" }),
      new File(["notes"], "notes.txt", { type: "text/plain" }),
      new File(["plan"], "plan.md", { type: "text/markdown" }),
    ]);

  await expect
    .poll(() => draft()?.files.map((file) => file.name))
    .toEqual(["notes.txt", "plan.md"]);
  expect(draft()?.files.every((file) => file.file !== null)).toBe(true);
  expect(errors.at(-1)).toBe("'empty.txt' is empty or could not be read.");
});

it("marks an answer's image that a reload would lose", async () => {
  setup();
  const store = useComposerDraftStore.getState();
  store.addImages(target, [
    {
      type: "image",
      id: "shot",
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 3,
      previewUrl: "data:image/png;base64,iVBORw0KGgo=",
      file: new File(["png"], "shot.png", { type: "image/png" }),
    },
  ]);
  const key = composerTargetKey(target);
  useComposerDraftStore.setState((state) => ({
    draftsByThreadKey: {
      ...state.draftsByThreadKey,
      [key]: { ...state.draftsByThreadKey[key]!, nonPersistedImageIds: ["shot"] },
    },
  }));
  await using _screen = await render(<Answer onError={() => {}} />, {
    router: false, // The strip reads no route.
  });
  await expect
    .element(page.getByRole("img", { name: "Draft attachment may not persist" }))
    .toBeInTheDocument();
});

// The reply mounts the intake beside its readiness, as an ask and the pinned ask do.
function Readiness() {
  const intake = useAnswerAttachmentIntake({ answerKey, support, onError: () => {} });
  const readiness = useAnswerAttachments().ready(answerKey, environmentId, intake.preparing);
  return <p>{"blocked" in readiness ? readiness.blocked : "Ready to send"}</p>;
}

it("holds an answer while an image is still being prepared", async () => {
  setup();
  await using screen = await render(<Readiness />, {
    router: false, // Readiness reads no route.
  });
  await expect.element(screen.getByText("Ready to send")).toBeInTheDocument();
  await act(() =>
    addPreparingComposerImages(composerTargetKey(target), [
      { id: "heic", name: "photo.heic", file: new File(["heic"], "photo.heic"), hidden: false },
    ]),
  );
  await expect
    .element(screen.getByText("Wait for the image to finish preparing."))
    .toBeInTheDocument();
  await act(() => removePreparingComposerImages(composerTargetKey(target), new Set(["heic"])));
  await expect.element(screen.getByText("Ready to send")).toBeInTheDocument();
});

it("lists a video restored without its bytes as a file row that opens its uploaded copy", async () => {
  setup();
  useComposerDraftStore.getState().addFiles(
    target,
    [
      {
        type: "file",
        id: "clip",
        name: "clip.mp4",
        mimeType: "video/mp4",
        sizeBytes: 2048,
        file: null,
        uploadedAttachmentId: "attachment-clip",
        uploadEnvironmentId: environmentId,
      },
    ],
    { appendReference: false },
  );
  await using screen = await render(<Answer onError={() => {}} />, {
    router: false, // The strip reads no route.
  });
  await expect.element(screen.getByRole("button", { name: "clip.mp4" })).toBeEnabled();
  expect(screen.container.querySelector('[aria-label="Play clip.mp4"]')).toBeNull();
});
