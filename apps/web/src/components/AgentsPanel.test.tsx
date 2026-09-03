import {
  deriveAgentPanelModel,
  emptyAgentPanelModel,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { AgentsPanel } from "./AgentsPanel";

describe("AgentsPanel", () => {
  it("keeps the empty panel scoped to runtime agents", () => {
    const html = renderToStaticMarkup(<AgentsPanel model={emptyAgentPanelModel()} />);

    expect(html).toContain("No agents yet");
    expect(html).not.toContain("Assigned agent");
    expect(html).not.toContain("Built-in agents");
  });

  it("presents a completed direct spawn with a readable identity and summary", () => {
    const directAgent = {
      id: "subagent-1",
      kind: "subagent",
      title: "/root/scout",
      role: null,
      model: "gpt-5.6-terra",
      effort: "high",
      status: "completed",
      activationCount: 1,
      usage: { totalTokens: 1_200 },
      progress: null,
      lastToolName: "Read",
      result: "OK",
      error: null,
      outputFile: null,
      parentAgentId: null,
      agentIndex: null,
      phaseIndex: null,
      phaseTitle: null,
      attempt: null,
      workflowName: null,
      phases: [],
      runHandles: null,
      recentActivity: [],
      firstSeenAt: "2026-09-03T12:00:00.000Z",
      startedAt: "2026-09-03T12:00:00.000Z",
      completedAt: "2026-09-03T12:00:02.000Z",
      updatedAt: "2026-09-03T12:00:02.000Z",
    } satisfies RuntimeSubagent;
    const model = deriveAgentPanelModel({ agents: [directAgent], v2Projection: null });
    const html = renderToStaticMarkup(<AgentsPanel model={model} />);

    expect(html).toContain("Direct agents");
    expect(html).toContain("Scout");
    expect(html).toContain("/root/scout");
    expect(html).toContain("Completed successfully");
    expect(html).toContain("1 settled");
    expect(html).toContain("1.2k tokens");
    expect(html).not.toContain("Built-in agents");
  });
});
