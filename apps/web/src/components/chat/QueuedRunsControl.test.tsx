import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  workflow: null as unknown,
  participantLabels: new Map<string, string>(),
}));

vi.mock("@t3tools/client-runtime/environment", () => ({
  scopeThreadRef: () => ({}) as never,
}));

vi.mock("@t3tools/client-runtime/state/thread-workflows", () => ({
  deriveThreadQueueWorkflowState: () => state.workflow,
}));

vi.mock("../../state/entities", () => ({
  useThreadProjection: () => state.projection,
}));

vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    cancelQueuedRun: Symbol("cancelQueuedRun"),
    editQueuedRun: Symbol("editQueuedRun"),
    promoteQueuedRun: Symbol("promoteQueuedRun"),
    reorderQueuedRun: Symbol("reorderQueuedRun"),
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => undefined,
}));

vi.mock("../../j5/a2a/ParticipantIdentitiesClient", () => ({
  useParticipantLabels: () => state.participantLabels,
}));

import { QueuedRunsControl } from "./QueuedRunsControl";

describe("QueuedRunsControl automatic completion delivery", () => {
  it("does not render a queue control when only hidden delivery remains", () => {
    state.projection = {
      projection: {
        messages: [
          {
            delegatedCompletion: {
              parentRunId: "run:parent",
              generation: 1,
              taskIds: ["task:child"],
            },
            id: "message:completion",
          },
        ],
      },
    };
    state.workflow = {
      activeRun: { id: "run:active" },
      canPromoteToSteer: true,
      canReorder: true,
      queuedRuns: [],
    };

    const html = renderToStaticMarkup(
      <QueuedRunsControl
        environmentId={"environment:test" as never}
        optimisticMessages={[]}
        threadId={"thread:test" as never}
      />,
    );

    expect(html).toBe("");
  });

  it("renders queued peer delivery sender and first line through the shared timeline formatter", () => {
    state.projection = { projection: {} };
    state.workflow = {
      activeRun: null,
      canPromoteToSteer: false,
      canReorder: false,
      queuedRuns: [
        {
          run: { id: "run:queued", userMessageId: "message:queued" },
          text: [
            "[Cross-agent message from agent:delivery-sender in squadron squadron:alpha]",
            "",
            "First line of the queued delivery.",
            "Second line is not the strip label.",
            "",
            "No reply is required. Use send_message without exchange_id only if a new message is needed.",
          ].join("\n"),
        },
      ],
    };
    state.participantLabels = new Map([["agent:delivery-sender", "Alice"]]);

    const html = renderToStaticMarkup(
      <QueuedRunsControl
        environmentId={"environment:test" as never}
        optimisticMessages={[]}
        threadId={"thread:test" as never}
      />,
    );

    expect(html).toContain("From Alice — First line of the queued delivery.");
    expect(html).not.toContain("Second line is not the strip label.");
  });

  it("keeps an unknown queued sender unnamed and exposes its durable id only in the tooltip", () => {
    state.participantLabels = new Map();
    const html = renderToStaticMarkup(
      <QueuedRunsControl
        environmentId={"environment:test" as never}
        optimisticMessages={
          [
            {
              id: "message:unknown",
              inputIntent: "queued_turn",
              text: [
                "[Cross-agent message from agent:unknown in squadron squadron:alpha]",
                "",
                "Queue fallback body.",
                "",
                "No reply is required. Use send_message without exchange_id only if a new message is needed.",
              ].join("\n"),
            },
          ] as never
        }
        threadId={"thread:test" as never}
      />,
    );

    expect(html).toContain("From Unnamed participant — Queue fallback body.");
    expect(html).toContain('title="agent:unknown"');
  });
});
