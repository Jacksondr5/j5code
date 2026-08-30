import { assert, describe, it } from "@effect/vitest";

import {
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3OrchestrationPromptForFirstRun,
  t3OrchestrationSystemPrompt,
} from "./T3OrchestrationInstructions.ts";

describe("T3 orchestration provider instructions", () => {
  it("steers only to current provider-native Subagents and addressable Peer Agents", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "provider-native Subagent");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "your provider's native Subagent mechanism");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "cannot create a new Peer Agent yet");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Use `list_participants`");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "expect_reply=true");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "open an Exchange");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "continue with other work");
    for (const excluded of [
      "spawn_agent",
      "delegate_task",
      "task_status",
      "task_cancel",
      "create_threads",
      "t3_thread_start",
      "In your brief, tell the new agent",
    ]) {
      assert.notInclude(T3_CODE_ORCHESTRATION_INSTRUCTIONS, excluded);
    }
  });

  it("documents structured schedules instead of JSON strings", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "structured object, never as JSON text");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, '"everyMs":3600000');
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "bindToCurrentThread=false");
  });

  it("injects prompt fallback only for an MCP-enabled first run", () => {
    const prompt = "Inspect the repository.";
    const injected = t3OrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 1,
      hasT3Mcp: true,
    });

    assert.include(injected, "<t3_code_orchestration_instructions>");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(
      t3OrchestrationPromptForFirstRun({ prompt, runOrdinal: 2, hasT3Mcp: true }),
      prompt,
    );
    assert.equal(
      t3OrchestrationPromptForFirstRun({ prompt, runOrdinal: 1, hasT3Mcp: false }),
      prompt,
    );
  });

  it("only exposes the system prompt when the T3 MCP server is attached", () => {
    assert.equal(t3OrchestrationSystemPrompt(false), undefined);
    assert.equal(t3OrchestrationSystemPrompt(true), T3_CODE_ORCHESTRATION_INSTRUCTIONS);
  });
});
