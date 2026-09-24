import { assert, it } from "@effect/vitest";
import { ProviderApprovalPolicy, RuntimeMode } from "@t3tools/contracts";

import {
  J5_COORDINATION_TOOLS,
  J5_PREAPPROVED_TOOLS,
  j5ApprovalPolicyIsNever,
  j5PreapprovedTools,
  j5T3McpToolName,
} from "./j5ToolPreapproval.ts";
import {
  J5_APPROVAL_POLICY_MATRIX,
  J5_NEVER_PREAPPROVED_TOOLS,
} from "./j5ToolPreapproval.testkit.ts";
import { J5Toolkit } from "./tools.ts";

// Adapter tests walk this matrix, so a runtime mode or approval policy missing here is a mode no
// harness append is checked in.
it("covers every runtime mode and every explicit approval policy", () => {
  const policies = J5_APPROVAL_POLICY_MATRIX.flatMap(({ policy }) =>
    policy === undefined ? [] : [policy],
  );
  assert.sameMembers(
    [...new Set(policies.map((policy) => policy.runtimeMode))],
    [...RuntimeMode.literals],
  );
  assert.sameMembers(
    [...new Set(policies.flatMap((policy) => policy.approvalPolicy ?? []))],
    [...ProviderApprovalPolicy.literals],
  );
});

it("recognizes policies that need the full J5 set to avoid outright rejection", () => {
  for (const { label, policy, never } of J5_APPROVAL_POLICY_MATRIX)
    assert.strictEqual(j5ApprovalPolicyIsNever(policy), never, label);
});

// Pinned by name: a server-wide default would also wave through worktree
// handoff, browser preview, and scheduling for a read-only persona (Sentry S-1, 2026-09-14).
it("names exactly the J5 verbs plus the artifact and Subagent verbs", () => {
  assert.sameMembers(
    [...J5_PREAPPROVED_TOOLS],
    [
      ...Object.keys(J5Toolkit.tools),
      "write_artifact",
      // Refused members are told to use delegate_task; it must not then be refused by the sandbox.
      "delegate_task",
      "task_status",
      "task_cancel",
    ],
  );
  assert.sameMembers(
    [...J5_COORDINATION_TOOLS],
    [
      "send_message",
      "clear_own_ask",
      "propose_crew",
      "request_crew_member",
      "playbook_start",
      "playbook_next",
      "playbook_back",
      "playbook_reselect",
      "playbook_complete",
      "playbook_cancel",
    ],
  );
});

it("pre-approves the full set only under never, coordination otherwise", () => {
  for (const { label, policy, never } of J5_APPROVAL_POLICY_MATRIX) {
    const tools = j5PreapprovedTools(policy);
    assert.sameMembers(
      [...tools],
      [...(never ? J5_PREAPPROVED_TOOLS : J5_COORDINATION_TOOLS)],
      label,
    );
    for (const name of J5_NEVER_PREAPPROVED_TOOLS) assert.notInclude(tools, name, label);
    if (!never)
      for (const name of [
        "spawn_agent",
        "stop_agent",
        "stop_crew",
        "archive_crew",
        "delegate_task",
      ])
        assert.notInclude(tools, name, label);
  }
});

it("qualifies tool names the way Claude-style harnesses match them", () => {
  assert.strictEqual(j5T3McpToolName("propose_crew"), "mcp__t3-code__propose_crew");
});
