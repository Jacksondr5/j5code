import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import type { CrewRuntimeRequestItem } from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";

export type PendingCrewApproval = Pick<
  CrewRuntimeRequestItem,
  "requestId" | "createdAt" | "requestKind" | "detail" | "appName" | "options"
>;

/**
 * The provider approvals on one thread that the Inbox can answer: the ones the composer's
 * `derivePendingThreadRequests` (client-runtime `state/threadRequests.ts`) shows as answerable
 * (`responseCapability` `live`), described the same way. Questions, `auth_refresh`,
 * `dynamic_tool_call`, and approvals the provider can no longer take stay in the thread. The
 * server reads this, and a client-runtime test holds it to the composer's selector.
 */
export const inboxAnswerableApprovals = (
  projection: Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems">,
): ReadonlyArray<PendingCrewApproval> =>
  projection.runtimeRequests.flatMap((request): Array<PendingCrewApproval> => {
    if (request.status !== "pending" || request.responseCapability.type !== "live") return [];
    if (
      request.kind === "user_input" ||
      request.kind === "auth_refresh" ||
      request.kind === "dynamic_tool_call"
    )
      return [];
    const item = projection.turnItems.findLast(
      (candidate) => candidate.type === "approval_request" && candidate.requestId === request.id,
    );
    const approval = item?.type === "approval_request" ? item : undefined;
    return [
      {
        requestId: request.id,
        requestKind: request.kind,
        createdAt: DateTime.formatIso(request.createdAt),
        ...(approval?.prompt ? { detail: approval.prompt } : {}),
        ...(approval?.appName ? { appName: approval.appName } : {}),
        ...(approval?.options !== undefined ? { options: approval.options } : {}),
      },
    ];
  });
