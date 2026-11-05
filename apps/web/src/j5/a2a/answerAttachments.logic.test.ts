import { describe, expect, it } from "vite-plus/test";

import { stageAnswerAttachments } from "./answerAttachments.logic";

const file = (name: string, type: string, size = 3) =>
  new File([new Uint8Array(size)], name, { type });

const stage = (
  files: ReadonlyArray<File>,
  options: { readonly maxFileBytes?: number | null; readonly current?: number } = {},
) => {
  const previews: string[] = [];
  let next = 0;
  const result = stageAnswerAttachments({
    current: Array.from({ length: options.current ?? 0 }, (_, index) => ({
      type: "file" as const,
      id: `existing-${index}`,
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      file: null,
    })),
    files,
    maxFileBytes: options.maxFileBytes === undefined ? 1024 : options.maxFileBytes,
    newId: () => `id-${next++}`,
    previewUrl: (picked) => {
      previews.push(picked.name);
      return `blob:${picked.name}`;
    },
  });
  return { result, previews };
};

describe("staging files on an answer", () => {
  it("takes a screenshot as an image and a log as a file", () => {
    const { result } = stage([file("shot.png", "image/png"), file("run.log", "text/plain")]);
    expect(result).toEqual({
      attachments: [
        expect.objectContaining({ type: "image", name: "shot.png", previewUrl: "blob:shot.png" }),
        expect.objectContaining({ type: "file", name: "run.log", mimeType: "text/plain" }),
      ],
    });
  });

  it("takes images but refuses files where the server accepts no files", () => {
    expect(stage([file("shot.png", "image/png")], { maxFileBytes: null }).result).toHaveProperty(
      "attachments",
    );
    expect(stage([file("run.log", "text/plain")], { maxFileBytes: null }).result).toEqual({
      error: "This server does not accept files. Attach images only.",
    });
  });

  it("refuses a file over the server's limit and makes no preview for the batch", () => {
    const { result, previews } = stage(
      [file("shot.png", "image/png"), file("dump.bin", "application/octet-stream", 2048)],
      { maxFileBytes: 1024 },
    );
    expect(result).toHaveProperty("error");
    expect(previews).toEqual([]);
  });

  it("refuses a batch that takes the answer past the attachment count limit", () => {
    expect(stage([file("run.log", "text/plain")], { current: 100 }).result).toHaveProperty("error");
  });
});
