import {
  EnvironmentId,
  MessageId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  projection: null as OrchestrationV2ThreadProjection | null,
  labels: new Map([["agent:peer", "Morgan"]]),
  command: vi.fn(async (_command: string, _input: unknown) => {}),
}));
vi.mock("../../state/entities", () => ({
  useThreadProjection: () => ({ projection: fixture.projection }),
}));
vi.mock("../../j5/a2a/ParticipantIdentitiesClient", () => ({
  useParticipantLabels: () => fixture.labels,
}));
vi.mock("../../assets/assetUrls", () => ({
  useAssetUrls: (_environmentId: unknown, resources: readonly unknown[]) =>
    resources.map(() => "https://assets.test/image"),
}));
vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    reorderQueuedRun: "reorder",
    promoteQueuedRun: "promote",
    cancelQueuedRun: "cancel",
    interruptTurn: "interrupt",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (input: unknown) => fixture.command(command, input),
}));
// The node renderer exercises queue behavior; floating tooltip positioning requires M5's browser pass.
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipPopup: () => null,
  TooltipTrigger: ({
    render,
    children,
  }: {
    render: ReactElement<{ children?: ReactNode }>;
    children?: ReactNode;
  }) => cloneElement(render, {}, children ?? render.props.children),
}));
import { QueuedRunsControl } from "./QueuedRunsControl";

const environmentId = EnvironmentId.make("remote-queue");
const threadId = ThreadId.make("queue-thread");
const peerMessage =
  "[Cross-agent message from agent:peer in squadron squadron:one]\n\nReview this change.\n\nNo reply is required. Use send_message without exchange_id only if a new message is needed.";
const attachment = {
  type: "image",
  id: "image-1",
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 10,
};
const projection = (steerable: boolean, nativeSteer = true) =>
  ({
    thread: { id: threadId, activeProviderThreadId: "provider-thread" },
    runs: [
      {
        id: "active",
        status: steerable ? "running" : "starting",
        activeAttemptId: "attempt",
        providerThreadId: "provider-thread",
        ordinal: 1,
      },
      { id: "queue-1", status: "queued", userMessageId: "message-1", ordinal: 2, queuePosition: 1 },
      { id: "queue-2", status: "queued", userMessageId: "message-2", ordinal: 3, queuePosition: 2 },
    ],
    messages: [
      { id: "message-1", text: peerMessage, attachments: [attachment] },
      { id: "message-2", text: "Second message", attachments: [] },
    ],
    providerThreads: [
      { id: "provider-thread", appThreadId: threadId, providerSessionId: "session" },
    ],
    providerSessions: [
      {
        id: "session",
        status: "running",
        capabilities: {
          turns: {
            supportsQueuedMessages: true,
            supportsActiveSteering: nativeSteer,
            supportsSteeringByInterruptRestart: true,
          },
        },
      },
    ],
    providerTurns: steerable ? [{ runAttemptId: "attempt", status: "running" }] : [],
  }) as unknown as OrchestrationV2ThreadProjection;
let renderer: ReactTestRenderer | undefined;
const onEditQueuedRun = vi.fn();
const render = () => (
  <QueuedRunsControl
    environmentId={environmentId}
    threadId={threadId}
    optimisticMessages={[
      { id: MessageId.make("message-1"), inputIntent: "queued_turn", text: peerMessage },
    ]}
    editingRunId={null}
    onEditQueuedRun={onEditQueuedRun}
    onCancelEdit={() => {}}
  />
);
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.command.mockClear();
  onEditQueuedRun.mockClear();
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("queued peer rows in the upstream queue controls", () => {
  it("retains attachments and edit payloads, reorders with the keyboard, and promotes against the selected environment", async () => {
    fixture.projection = projection(true, false);
    await act(() => {
      renderer = create(render());
    });
    const root = renderer!.root;
    expect(JSON.stringify(renderer!.toJSON())).toContain("From Morgan — Review this change.");
    expect(root.findAllByType("li")).toHaveLength(2);
    expect(root.findByType("img").props.alt).toBe("screenshot.png");
    const edit = root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "Edit queued message")!;
    await act(() => edit.props.onClick());
    expect(onEditQueuedRun).toHaveBeenCalledWith({
      runId: "queue-1",
      messageId: "message-1",
      text: peerMessage,
      attachments: [attachment],
    });
    const reorder = root
      .findAllByType("button")
      .filter((button) => String(button.props["aria-label"]).startsWith("Reorder queued"))[1]!;
    await act(() => reorder.props.onKeyDown({ key: "ArrowUp", preventDefault() {} }));
    expect(fixture.command).toHaveBeenLastCalledWith("reorder", {
      environmentId,
      input: { threadId, runId: "queue-2", beforeRunId: "queue-1" },
    });
    const promote = root
      .findAllByType("button")
      .find((button) => button.children.includes("Interrupt and restart with this message"))!;
    expect(promote.props.disabled).toBe(false);
    await act(() => promote.props.onClick());
    expect(fixture.command).toHaveBeenLastCalledWith("promote", {
      environmentId,
      input: { threadId, queuedRunId: "queue-1", targetRunId: "active" },
    });
  });

  it("keeps unavailable steer separate from collapse and allows explicit interruption", async () => {
    fixture.projection = projection(false);
    await act(() => {
      renderer = create(render());
    });
    const root = renderer!.root;
    const buttons = root.findAllByType("button");
    const steer = buttons.find((button) => button.children.includes("Steer"))!;
    expect(steer.props.disabled).toBe(true);
    const collapse = buttons.find(
      (button) => button.props["aria-label"] === "Collapse queued messages",
    )!;
    expect(collapse.findAllByType("button")).toHaveLength(1);
    await act(() => collapse.props.onClick());
    expect(
      root
        .findAllByType("button")
        .some((button) => button.props["aria-label"] === "Expand queued messages"),
    ).toBe(true);
    const interrupt = buttons.find((button) => button.children.includes("Interrupt"))!;
    await act(() => interrupt.props.onClick());
    expect(fixture.command).toHaveBeenCalledExactlyOnceWith("interrupt", {
      environmentId,
      input: { threadId },
    });
    expect(root.findAllByType("li")).toHaveLength(2);
  });
});
