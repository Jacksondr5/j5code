import { describe, expect, it } from "@effect/vitest";

import type { ProviderAdapterV2RuntimePolicy } from "../../../orchestration-v2/ProviderAdapter.ts";

import {
  J5_CODEX_PREAPPROVED_TOOLS,
  codexApprovalPolicyIsNever,
  j5CodexT3McpServerConfig,
} from "./codexToolApproval.ts";

const policy = (input: {
  approvalPolicy?: unknown;
  runtimeMode: ProviderAdapterV2RuntimePolicy["runtimeMode"];
}): ProviderAdapterV2RuntimePolicy => ({
  runtimeMode: input.runtimeMode,
  interactionMode: "default",
  cwd: null,
  ...(input.approvalPolicy === undefined ? {} : { approvalPolicy: input.approvalPolicy }),
});

describe("Codex saved-agent tool approval", () => {
  it("recognizes approval policy never, explicitly and as the full-access default", () => {
    expect(
      codexApprovalPolicyIsNever(
        policy({ approvalPolicy: "never", runtimeMode: "approval-required" }),
      ),
    ).toBe(true);
    expect(codexApprovalPolicyIsNever(policy({ runtimeMode: "full-access" }))).toBe(true);
    expect(codexApprovalPolicyIsNever(policy({ runtimeMode: "approval-required" }))).toBe(false);
    expect(
      codexApprovalPolicyIsNever(
        policy({ approvalPolicy: "on-request", runtimeMode: "full-access" }),
      ),
    ).toBe(false);
    expect(codexApprovalPolicyIsNever(undefined)).toBe(false);
  });

  it("pre-approves only the listed tool, and only when approvals are off", () => {
    expect(J5_CODEX_PREAPPROVED_TOOLS).toEqual(["write_artifact"]);
    expect(
      j5CodexT3McpServerConfig(
        policy({ approvalPolicy: "never", runtimeMode: "approval-required" }),
      ),
    ).toEqual({
      tools: { write_artifact: { approval_mode: "approve" } },
    });
    expect(j5CodexT3McpServerConfig(policy({ runtimeMode: "approval-required" }))).toEqual({});
    expect(j5CodexT3McpServerConfig(undefined)).toEqual({});
  });
});
