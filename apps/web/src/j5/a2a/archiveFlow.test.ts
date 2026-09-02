import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  archiveWithPreflight,
  formatArchiveWarning,
  needsArchiveWarning,
  type ArchiveWarningConfirmation,
} from "./archiveFlow";
import * as client from "./archiveFlowClient";

const registered = (overrides: Partial<client.PreArchiveFacts> = {}): client.ArchivePreflight => ({
  facts: {
    state: "registered",
    threadId: ThreadId.make("thread:archive-flow"),
    squadronId: "squadron:archive-flow",
    participantId: "agent:archive-flow",
    retired: false,
    openExchanges: [],
    placementSubtree: { state: "none" },
    ...overrides,
  } as Extract<client.PreArchiveFacts, { state: "registered" }>,
  participantLabels: new Map([
    ["agent:waiter", "Waiter"],
    ["agent:recipient", "Recipient"],
    ["agent:child", "Child"],
  ]),
});

const archiveThreadRef = scopeThreadRef(
  "environment:archive-flow" as never,
  ThreadId.make("thread:archive-flow"),
);

describe("archive flow", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps a measured clean participant quiet", () => {
    expect(needsArchiveWarning(registered())).toBe(false);
  });

  it("builds every consequential fact into the existing dialog's two-line rows", () => {
    const inboundOpenedAt = new Date(Date.now() - 4 * 60 * 60_000).toISOString();
    const outboundOpenedAt = new Date(Date.now() - 15 * 60_000).toISOString();
    const preflight = registered({
      openExchanges: [
        {
          squadronId: "squadron:archive-flow",
          exchangeId: "exchange:inbound",
          direction: "inbound",
          replyObligation: "participant-owes-reply",
          counterpartyId: "agent:waiter",
          intent: "Review the release",
          urgency: "blocking",
          openedAt: inboundOpenedAt,
        },
        {
          squadronId: "squadron:archive-flow",
          exchangeId: "exchange:outbound",
          direction: "outbound",
          replyObligation: "counterparty-owes-reply",
          counterpartyId: "agent:recipient",
          intent: "Send the final note",
          urgency: "soon",
          openedAt: outboundOpenedAt,
        },
      ],
      placementSubtree: { state: "known", participantIds: ["agent:child"] },
    });

    const warning = formatArchiveWarning({ threadTitle: "Release agent", preflight });
    const markup = renderToStaticMarkup(warning.content);
    expect(needsArchiveWarning(preflight)).toBe(true);
    expect(warning.message).toBe("Archive Release agent?");
    expect(markup).toContain("Also archives 1 agent placed under Release agent:");
    expect(markup).toContain("Child");
    expect(markup).toContain("2 open asks will be terminated — counterparties are notified");
    expect(markup).toContain("Blocking");
    expect(markup).toContain("From");
    expect(markup).toContain("Waiter");
    expect(markup).toContain("Review the release");
    expect(markup).toContain("Soon");
    expect(markup).toContain("To");
    expect(markup).toContain("Recipient");
    expect(markup).toContain("Send the final note");
  });

  it("never presents an unreadable preflight as an empty clean list", () => {
    expect(needsArchiveWarning({ facts: null, participantLabels: new Map() })).toBe(true);
    expect(
      renderToStaticMarkup(
        formatArchiveWarning({
          threadTitle: "Archive target",
          preflight: registered({
            placementSubtree: { state: "unknown", reason: "placement-query-failed" },
          }),
        }).content,
      ),
    ).toContain("Placement subtree: couldn&#x27;t check.");
  });

  it("keeps unknown raw ids out of rows while retaining them only for a tooltip", () => {
    const unknownParticipantId = "agent:unresolved-counterparty";
    const preflight = registered({
      openExchanges: [
        {
          squadronId: "squadron:archive-flow",
          exchangeId: "exchange:unknown",
          direction: "inbound",
          replyObligation: "participant-owes-reply",
          counterpartyId: unknownParticipantId,
          intent: "Need an answer before archive",
          urgency: "fyi",
          openedAt: new Date().toISOString(),
        },
      ],
    });

    const warning = formatArchiveWarning({ threadTitle: "Archive target", preflight });
    const markup = renderToStaticMarkup(warning.content);
    expect(warning.message).not.toContain(unknownParticipantId);
    expect(markup).toContain("Unnamed participant");
    expect(markup).toContain(`title="${unknownParticipantId}"`);
  });

  it("marks a resolved human counterparty as an inbox recipient", () => {
    const humanParticipantId = "human:jackson";
    const preflight = registered({
      openExchanges: [
        {
          squadronId: "squadron:archive-flow",
          exchangeId: "exchange:human",
          direction: "outbound",
          replyObligation: "counterparty-owes-reply",
          counterpartyId: humanParticipantId,
          intent: "Please confirm the rollout",
          urgency: "soon",
          openedAt: new Date().toISOString(),
        },
      ],
    });
    const withHumanLabel = {
      ...preflight,
      participantLabels: new Map([...preflight.participantLabels, [humanParticipantId, "Jackson"]]),
    };

    expect(
      renderToStaticMarkup(
        formatArchiveWarning({ threadTitle: "Archive target", preflight: withHumanLabel }).content,
      ),
    ).toContain("Jackson (inbox)");
  });

  it("opens exactly one destructive confirmation only when facts warrant it", async () => {
    const preflight = registered({
      placementSubtree: { state: "unknown", reason: "placement-query-failed" },
    });
    vi.spyOn(client, "readArchivePreflight").mockResolvedValue(preflight);
    const confirm = vi.fn<(confirmation: ArchiveWarningConfirmation) => Promise<boolean>>(
      async () => true,
    );
    const archive = vi.fn(async () => "archived");

    await expect(
      archiveWithPreflight({
        threadRef: archiveThreadRef,
        threadTitle: "Archive target",
        confirm,
        archive,
      }),
    ).resolves.toBe("archived");

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Archive Archive target?" }),
    );
    expect(archive).toHaveBeenCalledTimes(1);
  });

  it("warns and archives if production preflight reading fails", async () => {
    vi.spyOn(client, "readArchivePreflight").mockRejectedValue(new Error("network unavailable"));
    const confirm = vi.fn<(confirmation: ArchiveWarningConfirmation) => Promise<boolean>>(
      async () => true,
    );
    const archive = vi.fn(async () => "archived");

    await expect(
      archiveWithPreflight({
        threadRef: archiveThreadRef,
        threadTitle: "Archive target",
        confirm,
        archive,
      }),
    ).resolves.toBe("archived");

    expect(renderToStaticMarkup(confirm.mock.calls[0]?.[0]?.content ?? null)).toContain(
      "Couldn&#x27;t check open asks or the placement subtree.",
    );
    expect(archive).toHaveBeenCalledTimes(1);
  });

  it("archives a measured clean participant without the J5 warning", async () => {
    vi.spyOn(client, "readArchivePreflight").mockResolvedValue(registered());
    const confirm = vi.fn<(confirmation: ArchiveWarningConfirmation) => Promise<boolean>>(
      async () => true,
    );
    const archive = vi.fn(async () => "archived");

    await expect(
      archiveWithPreflight({
        threadRef: archiveThreadRef,
        threadTitle: "Archive target",
        confirm,
        archive,
      }),
    ).resolves.toBe("archived");

    expect(confirm).not.toHaveBeenCalled();
    expect(archive).toHaveBeenCalledTimes(1);
  });

  it("preserves a requested plain confirmation for a measured clean participant", async () => {
    vi.spyOn(client, "readArchivePreflight").mockResolvedValue(registered());
    const confirm = vi.fn<(confirmation: ArchiveWarningConfirmation) => Promise<boolean>>(
      async () => true,
    );
    const confirmCleanArchive = vi.fn(async () => false);
    const archive = vi.fn(async () => "archived");

    await expect(
      archiveWithPreflight({
        threadRef: archiveThreadRef,
        threadTitle: "Archive target",
        confirm,
        confirmCleanArchive,
        archive,
      }),
    ).resolves.toBeUndefined();

    expect(confirm).not.toHaveBeenCalled();
    expect(confirmCleanArchive).toHaveBeenCalledTimes(1);
    expect(archive).not.toHaveBeenCalled();
  });

  it("warns before archiving a consequential non-primary thread", async () => {
    const remoteThreadRef = scopeThreadRef(
      "environment:remote" as never,
      ThreadId.make("thread:remote-archive-flow"),
    );
    vi.spyOn(client, "readArchivePreflight").mockImplementation(async (threadRef) => {
      expect(threadRef).toEqual(remoteThreadRef);
      return registered({
        openExchanges: [
          {
            squadronId: "squadron:archive-flow",
            exchangeId: "exchange:remote-inbound",
            direction: "inbound",
            replyObligation: "participant-owes-reply",
            counterpartyId: "agent:waiter",
            intent: "Wait for the remote archive",
            urgency: "blocking",
            openedAt: new Date().toISOString(),
          },
        ],
      });
    });
    const confirm = vi.fn<(confirmation: ArchiveWarningConfirmation) => Promise<boolean>>(
      async () => true,
    );
    const archive = vi.fn(async () => "archived");

    await expect(
      archiveWithPreflight({
        threadRef: remoteThreadRef,
        threadTitle: "Remote archive target",
        confirm,
        archive,
      }),
    ).resolves.toBe("archived");

    expect(renderToStaticMarkup(confirm.mock.calls[0]?.[0]?.content ?? null)).toContain(
      "Wait for the remote archive",
    );
    expect(archive).toHaveBeenCalledTimes(1);
  });
});
