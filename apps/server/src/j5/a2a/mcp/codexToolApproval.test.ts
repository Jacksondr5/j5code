import { assert, it } from "@effect/vitest";

import { j5CodexT3McpServerConfig } from "./codexToolApproval.ts";
import { j5PreapprovedTools } from "./j5ToolPreapproval.ts";
import {
  J5_APPROVAL_POLICY_MATRIX,
  J5_NEVER_PREAPPROVED_TOOLS,
} from "./j5ToolPreapproval.testkit.ts";

it("approves exactly the shared J5 set per tool in every runtime policy", () => {
  for (const { label, policy } of J5_APPROVAL_POLICY_MATRIX) {
    const config = j5CodexT3McpServerConfig(policy);
    assert.notProperty(config, "default_tools_approval_mode", label);
    assert.sameMembers(Object.keys(config.tools), [...j5PreapprovedTools(policy)], label);
    for (const entry of Object.values(config.tools))
      assert.deepEqual(entry, { approval_mode: "approve" }, label);
    for (const name of J5_NEVER_PREAPPROVED_TOOLS) assert.notProperty(config.tools, name, label);
  }
});
