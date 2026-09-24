import type { J5RuntimePolicy } from "./j5ToolPreapproval.ts";

/**
 * Every runtime policy shape an adapter append must handle, with whether it resolves to approval
 * policy `never` (and so gets the full J5 set). Each harness's test walks this matrix.
 */
export const J5_APPROVAL_POLICY_MATRIX: ReadonlyArray<{
  readonly label: string;
  readonly policy: J5RuntimePolicy | undefined;
  readonly never: boolean;
}> = [
  { label: "no policy", policy: undefined, never: false },
  { label: "full-access", policy: { runtimeMode: "full-access" }, never: true },
  {
    label: "approval-required with never",
    policy: { runtimeMode: "approval-required", approvalPolicy: "never" },
    never: true,
  },
  { label: "approval-required", policy: { runtimeMode: "approval-required" }, never: false },
  { label: "auto", policy: { runtimeMode: "auto" }, never: false },
  { label: "auto-accept-edits", policy: { runtimeMode: "auto-accept-edits" }, never: false },
  {
    label: "full-access with on-request",
    policy: { runtimeMode: "full-access", approvalPolicy: "on-request" },
    never: false,
  },
  {
    label: "full-access with untrusted",
    policy: { runtimeMode: "full-access", approvalPolicy: "untrusted" },
    never: false,
  },
  {
    label: "full-access with on-failure",
    policy: { runtimeMode: "full-access", approvalPolicy: "on-failure" },
    never: false,
  },
];

/** t3-code tools outside the J5 set that must keep the harness's own verdict in every mode. */
export const J5_NEVER_PREAPPROVED_TOOLS: ReadonlyArray<string> = [
  "archive_agent",
  "t3_worktree_handoff",
  "preview_open",
  "schedule_task",
];
