import {
  RuntimeRequestId,
  type OrchestrationV2ThreadProjection,
  type ProviderSessionId,
} from "@t3tools/contracts";
import { inboxAnswerableApprovals } from "@t3tools/shared/j5/crewRuntimeRequests";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { derivePendingThreadRequests } from "../state/threadRequests.ts";

type Request = OrchestrationV2ThreadProjection["runtimeRequests"][number];
type Capability = Request["responseCapability"];
const live: Capability = { type: "live", providerSessionId: "session:1" as ProviderSessionId };
const at = DateTime.makeUnsafe("2026-09-25T12:00:00.000Z");

const request = (
  id: string,
  kind: Request["kind"],
  responseCapability: Capability = live,
  status: Request["status"] = "pending",
): Request =>
  ({
    id: RuntimeRequestId.make(id),
    kind,
    status,
    responseCapability,
    createdAt: at,
    resolvedAt: null,
  }) as unknown as Request;

const question = {
  id: "q1",
  header: "Branch",
  question: "Which branch?",
  options: [{ label: "main", description: "Default" }],
};

// Every branch the composer's selector takes: kinds it hides, questions, each response
// capability, approvals with and without display data, and a resolved request.
const projection = {
  runtimeRequests: [
    request("approve-live", "command"),
    request("approve-options", "mcp-elicitation"),
    request("approve-message", "file-change", { type: "message" }),
    request("approve-gone", "file-read", { type: "not_resumable", reason: "session ended" }),
    request("approve-bare", "command"),
    request("hidden-auth", "auth_refresh"),
    request("hidden-tool", "dynamic_tool_call"),
    request("ask-live", "user_input"),
    request("done", "command", live, "resolved"),
  ],
  turnItems: [
    { type: "approval_request", requestId: "approve-live", prompt: "Run tests?", appName: "CI" },
    {
      type: "approval_request",
      requestId: "approve-options",
      prompt: "Let the app read your calendar?",
      options: [{ decision: "accept", label: "Allow", warning: "Grants access for good." }],
    },
    { type: "approval_request", requestId: "approve-message", prompt: "Write file?" },
    { type: "approval_request", requestId: "approve-gone", prompt: "Read file?" },
    { type: "user_input_request", requestId: "ask-live", questions: [question] },
  ],
} as unknown as Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems">;

describe("the Inbox's Crew approval selector", () => {
  it("selects exactly the composer's answerable approvals, described the same way", () => {
    const fromComposer = derivePendingThreadRequests(projection)
      .approvals.filter((approval) => approval.responseCapability === "live")
      .map(({ responseCapability: _live, ...approval }) => approval);
    expect(inboxAnswerableApprovals(projection)).toEqual(fromComposer);
    // The fixture reaches every branch, so a drift in either selector shows up here.
    expect(fromComposer.map((entry) => entry.requestId)).toEqual([
      "approve-live",
      "approve-options",
      "approve-bare",
    ]);
  });
});
