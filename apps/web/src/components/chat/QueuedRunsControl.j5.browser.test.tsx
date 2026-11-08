import { EnvironmentId, ThreadId, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  projection: null as OrchestrationV2ThreadProjection | null,
  command: vi.fn(async (_command: unknown, _input: unknown) => {}),
}));
vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadProjection: (() => ({ projection: fixture.projection })) as never,
}));
vi.mock(import("../../j5/a2a/ParticipantIdentitiesClient"), async (importOriginal) => ({
  ...(await importOriginal()),
  useParticipantIdentities: (() => ({
    labels: new Map([["agent:peer", "Morgan"]]),
    threads: new Map(),
  })) as never,
}));
// Shared-conversation authorship (case 80) is not under test; a solo thread shows runs as queued.
vi.mock(import("../../j5/sharing/sharedTimeline"), async (importOriginal) => ({
  ...(await importOriginal()),
  useSharedQueuedRuns: ((_environmentId: unknown, _threadId: unknown, queued: unknown) =>
    queued) as never,
}));
vi.mock(import("../../assets/assetUrls"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAssetUrls: ((_environmentId: unknown, resources: readonly unknown[]) =>
    resources.map(() => "https://assets.test/image")) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: ((command: unknown) => (input: unknown) =>
    fixture.command(command, input)) as never,
}));

import "~/index.css";
import { render } from "../../../test/render";
import { threadEnvironment } from "../../state/threads";
import { QueuedRunsControl } from "./QueuedRunsControl";

const environmentId = EnvironmentId.make("remote-queue");
const deliveryId = "message:j5:a2a:delivery:peer-1";
const createdAt = DateTime.makeUnsafe("2026-11-07T12:00:00.000Z");
const threadId = ThreadId.make("queue-thread");
const peerMessage =
  "[Cross-agent message from agent:peer in project project-one (One)]\n\nReview this change.\n\nNo reply is required. Use j5_send_message without exchange_id only if a new message is needed.";
const attachment = {
  type: "image",
  id: "image-1",
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 10,
};
const projection = {
  thread: { id: threadId, activeProviderThreadId: "provider-thread" },
  runs: [
    {
      id: "active",
      status: "running",
      activeAttemptId: "attempt",
      providerThreadId: "provider-thread",
      ordinal: 1,
    },
    { id: "queue-1", status: "queued", userMessageId: deliveryId, ordinal: 2, queuePosition: 1 },
    { id: "queue-2", status: "queued", userMessageId: "message-2", ordinal: 3, queuePosition: 2 },
  ],
  messages: [
    {
      id: deliveryId,
      role: "user",
      createdBy: "agent",
      createdAt,
      text: peerMessage,
      attachments: [attachment],
    },
    {
      id: "message-2",
      role: "user",
      createdBy: "user",
      createdAt,
      text: "Second message",
      attachments: [],
    },
  ],
  providerThreads: [{ id: "provider-thread", appThreadId: threadId, providerSessionId: "session" }],
  providerSessions: [
    {
      id: "session",
      status: "running",
      capabilities: {
        turns: {
          supportsQueuedMessages: true,
          supportsActiveSteering: false,
          supportsSteeringByInterruptRestart: true,
        },
      },
    },
  ],
  providerTurns: [{ runAttemptId: "attempt", status: "running" }],
} as unknown as OrchestrationV2ThreadProjection;

it("folds a queued peer message under its sender on the left, edits it with its attachments, and acts on the thread's environment", async () => {
  fixture.projection = projection;
  const onEditQueuedRun = vi.fn();
  await using screen = await render(
    <QueuedRunsControl
      environmentId={environmentId}
      threadId={threadId}
      optimisticMessages={[]}
      editingRunId={null}
      editBlockedReason={null}
      onEditQueuedRun={onEditQueuedRun}
      onCancelEdit={() => {}}
      timestampFormat="locale"
      onOpenThread={() => {}}
    />,
  );

  // D38: the sender is named once, above a fold that previews the letter, not the envelope.
  await expect.element(screen.getByText("Morgan", { exact: true })).toBeVisible();
  await expect.element(screen.getByText(/From Morgan/)).not.toBeInTheDocument();
  const fold = screen.getByRole("button", { name: "Review this change." });
  await expect.element(fold).toHaveAttribute("aria-expanded", "false");
  await fold.click();
  await expect.element(screen.getByRole("img", { name: "screenshot.png" })).toBeVisible();
  await expect.element(screen.getByText(/Cross-agent message/)).not.toBeInTheDocument();

  const [peerRow, personRow] = Array.from(screen.container.querySelectorAll("li"));
  expect(getComputedStyle(peerRow!).alignItems).toBe("flex-start");
  expect(getComputedStyle(personRow!).alignItems).toBe("flex-end");

  await screen.getByRole("button", { name: "Edit queued message" }).first().click();
  expect(onEditQueuedRun).toHaveBeenCalledWith({
    runId: "queue-1",
    messageId: deliveryId,
    text: peerMessage,
    attachments: [attachment],
  });

  await screen.getByRole("button", { name: "Send now" }).first().click();
  expect(fixture.command).toHaveBeenLastCalledWith(threadEnvironment.promoteQueuedRun, {
    environmentId,
    input: { threadId, queuedRunId: "queue-1", targetRunId: "active" },
  });
});
