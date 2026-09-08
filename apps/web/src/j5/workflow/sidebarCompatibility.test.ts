import { WorkflowEntries } from "@j5/workflow-contracts/sidebar";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { normalizeWorkflowEntries } from "./client";

const decodeWorkflowEntries = Schema.decodeUnknownSync(WorkflowEntries);

describe("workflow sidebar rolling compatibility", () => {
  it("accepts entries from a server predating activity timestamps and counts", () => {
    const legacy = decodeWorkflowEntries({
      runs: [
        {
          id: "workflow:legacy",
          squadronId: "squadron:one",
          title: "Legacy workflow",
          phase: "plan_approval",
          status: "waiting_approval",
          revision: 4,
          gateRevision: 4,
        },
      ],
      hasMore: true,
    });

    expect(legacy.runs[0]?.updatedAt).toBeUndefined();
    expect(normalizeWorkflowEntries(legacy, 0)).toMatchObject({
      total: 2,
      waitingApprovalCount: null,
    });
  });
});
