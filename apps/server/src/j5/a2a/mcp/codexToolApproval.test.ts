import { assert, it } from "@effect/vitest";

import {
  J5_CODEX_PREAPPROVED_TOOLS,
  codexApprovalPolicyIsNever,
  j5CodexT3McpServerConfig,
} from "./codexToolApproval.ts";
import { J5Toolkit } from "./tools.ts";

it("pre-approves platform tools only where Codex would otherwise reject them outright", () => {
  assert.isTrue(codexApprovalPolicyIsNever({ runtimeMode: "full-access" }));
  assert.isTrue(
    codexApprovalPolicyIsNever({ runtimeMode: "approval-required", approvalPolicy: "never" }),
  );
  assert.isFalse(codexApprovalPolicyIsNever({ runtimeMode: "approval-required" }));
  assert.isFalse(codexApprovalPolicyIsNever({ runtimeMode: "auto" }));
  assert.isFalse(codexApprovalPolicyIsNever({ runtimeMode: "auto-accept-edits" }));
  assert.isFalse(
    codexApprovalPolicyIsNever({ runtimeMode: "full-access", approvalPolicy: "on-request" }),
  );
  assert.isFalse(codexApprovalPolicyIsNever(undefined));
  assert.deepEqual(j5CodexT3McpServerConfig({ runtimeMode: "auto" }), {});
});

// Pinned by name: a server-wide default would also wave through write_artifact, worktree
// handoff, browser preview, and scheduling for a read-only persona (Sentry S-1, 2026-09-14).
it("pre-approves exactly the J5 verbs, never the whole t3-code server", () => {
  const config = j5CodexT3McpServerConfig({ runtimeMode: "full-access" });
  assert.notProperty(config, "default_tools_approval_mode");
  assert.sameMembers(
    [...J5_CODEX_PREAPPROVED_TOOLS],
    [
      ...Object.keys(J5Toolkit.tools),
      "write_artifact",
      // Refused members are told to use delegate_task; it must not then be refused by the sandbox.
      "delegate_task",
      "task_status",
      "task_cancel",
    ],
  );
  assert.sameMembers(Object.keys((config as { tools: object }).tools), [
    ...J5_CODEX_PREAPPROVED_TOOLS,
  ]);
  for (const entry of Object.values((config as { tools: Record<string, unknown> }).tools))
    assert.deepEqual(entry, { approval_mode: "approve" });
  for (const upstream of ["t3_worktree_handoff", "preview_open", "schedule_task"])
    assert.notProperty((config as { tools: object }).tools, upstream);
});
