import { ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { archiveWithPreflight, formatArchiveWarning, needsArchiveWarning } from "./archiveFlow";
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

describe("archive flow", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps a measured clean participant quiet", () => {
    expect(needsArchiveWarning(registered())).toBe(false);
  });

  it("renders every consequential fact and the R15 reassurance before destructive confirmation", () => {
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
          openedAt: new Date(Date.now() - 4 * 60 * 60_000).toISOString(),
        },
        {
          squadronId: "squadron:archive-flow",
          exchangeId: "exchange:outbound",
          direction: "outbound",
          replyObligation: "counterparty-owes-reply",
          counterpartyId: "agent:recipient",
          intent: "Send the final note",
          urgency: "soon",
          openedAt: new Date(Date.now() - 15 * 60_000).toISOString(),
        },
      ],
      placementSubtree: { state: "known", participantIds: ["agent:child"] },
    });

    const warning = formatArchiveWarning({ threadTitle: "Release agent", preflight });
    expect(needsArchiveWarning(preflight)).toBe(true);
    expect(warning).toContain("Archive Release agent anyway?");
    expect(warning).toContain("Also archives 1 agent placed under Release agent: Child.");
    expect(warning).toContain("1 participant waiting for Release agent:");
    expect(warning).toContain("Waiter · blocking · Review the release · open 4h ago");
    expect(warning).toContain("1 open ask sent by Release agent:");
    expect(warning).toContain("Recipient · soon · Send the final note · open 15m ago");
    expect(warning).toContain(
      "Worktrees, branches, and pull requests remain. Cleanup is a separate action.",
    );
  });

  it("never presents an unreadable preflight as an empty clean list", () => {
    expect(needsArchiveWarning({ facts: null, participantLabels: new Map() })).toBe(true);
    expect(
      formatArchiveWarning({
        threadTitle: "Archive target",
        preflight: registered({
          placementSubtree: { state: "unknown", reason: "placement-query-failed" },
        }),
      }),
    ).toContain("Placement subtree: couldn't check.");
  });

  it("opens exactly one destructive confirmation only when facts warrant it", async () => {
    const preflight = registered({
      placementSubtree: { state: "unknown", reason: "placement-query-failed" },
    });
    vi.spyOn(client, "readArchivePreflight").mockResolvedValue(preflight);
    const confirm = vi.fn(async () => true);
    const archive = vi.fn(async () => "archived");

    await expect(
      archiveWithPreflight({
        threadId: ThreadId.make("thread:archive-flow"),
        threadTitle: "Archive target",
        confirm,
        archive,
      }),
    ).resolves.toBe("archived");

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Archive Archive target anyway?"));
    expect(archive).toHaveBeenCalledTimes(1);
  });

  it("warns and archives if production preflight reading fails", async () => {
    vi.spyOn(client, "readArchivePreflight").mockRejectedValue(new Error("network unavailable"));
    const confirm = vi.fn(async () => true);
    const archive = vi.fn(async () => "archived");

    await expect(
      archiveWithPreflight({
        threadId: ThreadId.make("thread:archive-flow"),
        threadTitle: "Archive target",
        confirm,
        archive,
      }),
    ).resolves.toBe("archived");

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Couldn't check open asks"));
    expect(archive).toHaveBeenCalledTimes(1);
  });

  it("archives a measured clean participant without the J5 warning", async () => {
    vi.spyOn(client, "readArchivePreflight").mockResolvedValue(registered());
    const confirm = vi.fn(async () => true);
    const archive = vi.fn(async () => "archived");

    await expect(
      archiveWithPreflight({
        threadId: ThreadId.make("thread:archive-flow"),
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
    const confirm = vi.fn(async () => true);
    const confirmCleanArchive = vi.fn(async () => false);
    const archive = vi.fn(async () => "archived");

    await expect(
      archiveWithPreflight({
        threadId: ThreadId.make("thread:archive-flow"),
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
});
