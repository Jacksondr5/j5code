import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import type { CrewRuntimeRequestItem } from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";

export type PendingCrewThreadRequest = Pick<
  CrewRuntimeRequestItem,
  "requestId" | "createdAt" | "responseCapability" | "request"
>;

/**
 * Pending provider approvals and questions on one thread, selected exactly as the composer's
 * `derivePendingThreadRequests` (client-runtime `state/threadRequests.ts`) selects them, so a
 * request the Inbox holds is one the thread would have shown inline: pending requests only,
 * questions with their `user_input_request` item, and approvals minus `auth_refresh` and
 * `dynamic_tool_call`, which are not the person's to answer. `responseCapability` follows the
 * composer too: an approval is answerable only when `live`, and a question answered by sending a
 * message reads as `message`. The server reads this, and a client-runtime test holds it to the
 * composer's selector.
 */
export const pendingCrewThreadRequests = (
  projection: Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems">,
): ReadonlyArray<PendingCrewThreadRequest> =>
  projection.runtimeRequests.flatMap((request): Array<PendingCrewThreadRequest> => {
    if (request.status !== "pending") return [];
    const capability = request.responseCapability.type;
    const base = { requestId: request.id, createdAt: DateTime.formatIso(request.createdAt) };
    if (request.kind === "user_input") {
      const item = projection.turnItems.findLast(
        (candidate) =>
          candidate.type === "user_input_request" && candidate.requestId === request.id,
      );
      if (item?.type !== "user_input_request") return [];
      return [
        {
          ...base,
          responseCapability:
            item.responseMode === "message" || capability === "message" ? "message" : capability,
          request: {
            kind: "user_input" as const,
            questions: item.questions.map((question) => ({
              ...question,
              multiSelect: question.multiSelect ?? false,
            })),
          },
        },
      ];
    }
    if (request.kind === "auth_refresh" || request.kind === "dynamic_tool_call") return [];
    const item = projection.turnItems.findLast(
      (candidate) => candidate.type === "approval_request" && candidate.requestId === request.id,
    );
    const approval = item?.type === "approval_request" ? item : undefined;
    return [
      {
        ...base,
        responseCapability: capability === "live" ? "live" : "not_resumable",
        request: {
          kind: "approval" as const,
          requestKind: request.kind,
          detail: approval?.prompt || null,
          appName: approval?.appName || null,
          options: approval?.options ?? null,
        },
      },
    ];
  });
