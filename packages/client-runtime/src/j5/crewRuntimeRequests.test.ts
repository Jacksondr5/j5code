import {
  RuntimeRequestId,
  type OrchestrationV2ThreadProjection,
  type ProviderSessionId,
} from "@t3tools/contracts";
import { pendingCrewThreadRequests } from "@t3tools/shared/j5/crewRuntimeRequests";
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

// Every branch the composer's selector takes: kinds it hides, a question with no item yet,
// each response capability, a question answered by message, and resolved requests.
const projection = {
  runtimeRequests: [
    request("approve-live", "command"),
    request("approve-message", "file-change", { type: "message" }),
    request("approve-gone", "file-read", { type: "not_resumable", reason: "session ended" }),
    request("approve-bare", "command"),
    request("hidden-auth", "auth_refresh"),
    request("hidden-tool", "dynamic_tool_call"),
    request("ask-live", "user_input"),
    request("ask-by-message", "user_input"),
    request("ask-message-capability", "user_input", { type: "message" }),
    request("ask-no-item", "user_input"),
    request("done", "command", live, "resolved"),
  ],
  turnItems: [
    { type: "approval_request", requestId: "approve-live", prompt: "Run tests?", appName: "CI" },
    { type: "approval_request", requestId: "approve-message", prompt: "Write file?" },
    { type: "approval_request", requestId: "approve-gone", prompt: "Read file?" },
    { type: "user_input_request", requestId: "ask-live", questions: [question] },
    {
      type: "user_input_request",
      requestId: "ask-by-message",
      questions: [{ ...question, multiSelect: true }],
      responseMode: "message",
    },
    { type: "user_input_request", requestId: "ask-message-capability", questions: [question] },
  ],
} as unknown as Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems">;

describe("the Inbox's Crew request selector", () => {
  it("selects and describes exactly what the composer's selector does", () => {
    const composer = derivePendingThreadRequests(projection);
    const fromComposer = [
      ...composer.approvals.map((approval) => ({
        requestId: approval.requestId,
        createdAt: approval.createdAt,
        responseCapability: approval.responseCapability,
        request: {
          kind: "approval",
          requestKind: approval.requestKind,
          detail: approval.detail ?? null,
          appName: approval.appName ?? null,
          options: approval.options ?? null,
        },
      })),
      ...composer.userInputs.map((input) => ({
        requestId: input.requestId,
        createdAt: input.createdAt,
        responseCapability: input.responseMode === "message" ? "message" : input.responseCapability,
        request: { kind: "user_input", questions: input.questions },
      })),
    ];
    const byId = (left: { requestId: string }, right: { requestId: string }) =>
      left.requestId.localeCompare(right.requestId);
    expect([...pendingCrewThreadRequests(projection)].toSorted(byId)).toEqual(
      fromComposer.toSorted(byId),
    );
    // The fixture reaches every branch, so a drift in either selector shows up here.
    expect(fromComposer.map((entry) => entry.requestId).toSorted()).toEqual([
      "approve-bare",
      "approve-gone",
      "approve-live",
      "approve-message",
      "ask-by-message",
      "ask-live",
      "ask-message-capability",
    ]);
  });
});
