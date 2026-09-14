import { assert, describe, it } from "@effect/vitest";
import { type ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  CLAUDE_PROVIDER,
  makeClaudeQueryOptions,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { buildCodexTurnStartParams } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "../../provider/T3OrchestrationInstructions.ts";

const CLAUDE_TEST_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make(CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
  options: [{ id: "effort", value: "ultrathink" }],
} satisfies ModelSelection;

describe("agent persona adapter instructions", () => {
  it("adds persona instructions to Claude's system prompt without requiring MCP", () => {
    const options = makeClaudeQueryOptions({
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      nativeThreadId: "native-builder-instructions",
      resume: false,
      cwd: "/workspace",
      agentPersonaInstructions: "Builder instructions",
    });

    assert.isObject(options.systemPrompt);
    const systemPrompt = options.systemPrompt as { readonly append?: string };
    assert.include(systemPrompt.append ?? "", "Builder instructions");
    assert.include(systemPrompt.append ?? "", "<runtime_info>");
    assert.notInclude(systemPrompt.append ?? "", T3_CODE_ORCHESTRATION_INSTRUCTIONS);
  });

  it.effect("adds persona instructions without requiring the T3 MCP server", () =>
    Effect.gen(function* () {
      const params = yield* buildCodexTurnStartParams({
        nativeThreadId: "native-builder-instructions",
        codexInput: [{ type: "text", text: "implement this handoff" }],
        runtimePolicy: {
          runtimeMode: "auto-accept-edits",
          interactionMode: "default",
          cwd: "/workspace",
          agentPersonaInstructions: "Builder instructions",
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-sol",
        },
        hasT3Mcp: false,
      });

      assert.equal(params.collaborationMode?.mode, "default");
      assert.equal(
        params.collaborationMode?.settings.developer_instructions,
        "Builder instructions",
      );
    }),
  );
});
