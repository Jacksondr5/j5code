import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { composerAttachmentUploadKey } from "../../lib/composerAttachmentUploadQueue";
import type { DraftComposerAttachment } from "../../lib/composerImages";
import {
  answerAttachmentDraftKey,
  answerAttachmentsReadiness,
  answerDraftItemKey,
} from "./answerAttachments.logic";

const environmentId = EnvironmentId.make("environment-1");
const target = {
  environmentId,
  personId: "person-a",
  projectId: "project-1",
  exchangeId: "exchange-1",
};
const serverConfig = {
  environment: {
    capabilities: { attachmentUploads: true, fileAttachments: { maxUploadBytes: 50_000_000 } },
  },
} as unknown as Parameters<typeof answerAttachmentsReadiness>[0]["serverConfig"];
const file = (id: string, uploaded: boolean): DraftComposerAttachment => ({
  id,
  type: "file",
  name: `${id}.pdf`,
  mimeType: "application/pdf",
  sizeBytes: 1_000,
  fileUri: `file:///${id}.pdf`,
  ...(uploaded
    ? { uploadedAttachmentId: `uploaded-${id}`, uploadEnvironmentId: environmentId }
    : {}),
});
const readiness = (
  attachments: ReadonlyArray<DraftComposerAttachment>,
  overrides: Partial<Parameters<typeof answerAttachmentsReadiness>[0]> = {},
) =>
  answerAttachmentsReadiness({
    target,
    attachments,
    preparing: 0,
    states: Object.fromEntries(
      attachments.map((attachment) => [
        composerAttachmentUploadKey(environmentId, attachment.id),
        { status: attachment.uploadedAttachmentId ? "ready" : "uploading", progress: 0 },
      ]),
    ) as Parameters<typeof answerAttachmentsReadiness>[0]["states"],
    serverConfig,
    ...overrides,
  });

describe("answer attachments", () => {
  it("keeps each person's attachments to their own answer of an ask", () => {
    const own = answerAttachmentDraftKey(target);
    expect(answerAttachmentDraftKey({ ...target, personId: "person-b" })).not.toBe(own);
    expect(answerAttachmentDraftKey({ ...target, projectId: "project-2" })).not.toBe(own);
    expect(own.startsWith(`${environmentId}:`)).toBe(true);
    // An ask's `scopedInboxItemKey`.
    expect(answerDraftItemKey(own)).toBe(
      JSON.stringify([environmentId, "person-a", "project-1", "exchange-1"]),
    );
    expect(answerDraftItemKey(`${environmentId}:thread-1`)).toBeNull();
  });

  it("sends the uploaded references, and holds the answer until every attachment is uploaded", () => {
    expect(readiness([])).toEqual({ attachments: [] });
    expect(readiness([file("one", true)])).toEqual({
      attachments: [
        {
          type: "file",
          id: "uploaded-one",
          name: "one.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1_000,
        },
      ],
    });
    expect(readiness([file("one", true), file("two", false)])).toEqual({
      blocked: "Attachments are still uploading",
    });
    expect(
      readiness([file("one", false)], {
        states: {
          [composerAttachmentUploadKey(environmentId, "one")]: { status: "failed", progress: 0 },
        } as unknown as Parameters<typeof answerAttachmentsReadiness>[0]["states"],
      }),
    ).toEqual({ blocked: "Retry or remove the failed attachment" });
    // Uploaded to another server: the asking server has none of it.
    expect(
      readiness([
        { ...file("one", true), uploadEnvironmentId: EnvironmentId.make("environment-2") },
      ]),
    ).toEqual({ blocked: "Attachments are not uploaded yet" });
  });

  it("holds the answer while a pick or paste is still becoming an attachment", () => {
    expect(readiness([], { preparing: 1 })).toEqual({
      blocked: "Attachments are still being added",
    });
  });
});
