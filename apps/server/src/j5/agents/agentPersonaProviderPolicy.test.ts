import { assert, describe, it } from "@effect/vitest";
import {
  type AgentPersonaAuthorityPolicy,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { buildCodexTurnStartParams } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import {
  CLAUDE_READ_ONLY_ALLOWED_TOOLS,
  claudeRuntimeQueryPolicyForRuntimePolicy,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  providerCanEnforceAgentPersonaAuthority,
  translateAgentPersonaProviderPolicy,
} from "./agentPersonaProviderPolicy.ts";

const runtimePolicy = (
  authorityPolicy: AgentPersonaAuthorityPolicy,
  driver: "codex" | "claudeAgent" = "codex",
) => ({
  ...translateAgentPersonaProviderPolicy(authorityPolicy, ProviderDriverKind.make(driver)),
  interactionMode: "default" as const,
  cwd: "/workspace",
});

describe("agent persona provider policy", () => {
  it("translates inspection policies to non-interactive read-only access", () => {
    for (const authorityPolicy of ["read-only", "critic-review"] as const) {
      assert.deepEqual(
        translateAgentPersonaProviderPolicy(authorityPolicy, ProviderDriverKind.make("codex")),
        {
          runtimeMode: "approval-required",
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "fullAccess" },
            networkAccess: false,
          },
        },
      );
    }
  });

  it("translates editing policies to workspace-scoped writes", () => {
    for (const authorityPolicy of ["workspace-write", "critic-fix"] as const) {
      assert.deepEqual(
        translateAgentPersonaProviderPolicy(authorityPolicy, ProviderDriverKind.make("codex")),
        {
          runtimeMode: "auto-accept-edits",
          approvalPolicy: "never",
          sandboxPolicy: { type: "workspaceWrite", networkAccess: false },
        },
      );
    }
  });

  it("runs unsandboxed in the fallback mode when a provider cannot enforce the authority", () => {
    for (const [authorityPolicy, driver] of [
      ["workspace-write", "claudeAgent"],
      ["critic-fix", "claudeAgent"],
      ["diagnostic", "codex"],
      ["publish-only", "codex"],
      ["read-only", "cursor"],
    ] as const) {
      assert.isFalse(
        providerCanEnforceAgentPersonaAuthority(ProviderDriverKind.make(driver), authorityPolicy),
      );
      assert.deepEqual(
        translateAgentPersonaProviderPolicy(authorityPolicy, ProviderDriverKind.make(driver)),
        { runtimeMode: "full-access" },
      );
      assert.deepEqual(
        translateAgentPersonaProviderPolicy(
          authorityPolicy,
          ProviderDriverKind.make(driver),
          "approval-required",
        ),
        { runtimeMode: "approval-required" },
      );
    }
  });

  it.effect("compiles the canonical policies into Codex turn settings", () =>
    Effect.gen(function* () {
      const build = (authorityPolicy: AgentPersonaAuthorityPolicy) =>
        buildCodexTurnStartParams({
          nativeThreadId: `native-${authorityPolicy}`,
          codexInput: [{ type: "text", text: "test" }],
          runtimePolicy: runtimePolicy(authorityPolicy),
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.6-terra",
          },
        });

      const readOnly = yield* build("critic-review");
      const workspaceWrite = yield* build("critic-fix");
      const publish = yield* build("publish-only");

      assert.equal(readOnly.approvalPolicy, "never");
      assert.equal(readOnly.sandboxPolicy?.type, "readOnly");
      assert.equal(workspaceWrite.approvalPolicy, "never");
      assert.equal(workspaceWrite.sandboxPolicy?.type, "workspaceWrite");
      // Codex can't sandbox publish-only, so the thread's own full-access mode applies.
      assert.equal(publish.sandboxPolicy?.type, "dangerFullAccess");
    }),
  );

  it("compiles the canonical policies into Claude permission modes", () => {
    assert.deepEqual(claudeRuntimeQueryPolicyForRuntimePolicy(runtimePolicy("critic-review")), {
      permissionMode: "dontAsk",
      tools: CLAUDE_READ_ONLY_ALLOWED_TOOLS,
      allowedTools: CLAUDE_READ_ONLY_ALLOWED_TOOLS,
      installPermissionCallback: false,
    });
  });
});
