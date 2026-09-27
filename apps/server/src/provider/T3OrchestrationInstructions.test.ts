import { assert, describe, it } from "@effect/vitest";

import {
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationPromptForFirstRun,
  t3OrchestrationSystemPrompt,
} from "./T3OrchestrationInstructions.ts";

describe("T3 orchestration provider instructions", () => {
  it("steers to provider-native Subagents and platform Peer Agents", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "provider-native Subagent");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "your provider's native Subagent mechanism");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Use platform `spawn_agent`");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "what should come back in that brief");
    // Crews are the third shape of help; without this bullet an agent asked for a crew makes subagents.
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "A Crew is a group of Peer Agents");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Use `propose_crew`");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Use `list_participants`");
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "later work owed by an existing participant",
    );
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "expect_reply=true");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "open an Exchange");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "continue with other work");
    // J5 re-declares delegate_task for personas; only its persona use is advertised.
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "`delegate_task` with persona=ID");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "`@persona:ID`");
    for (const excluded of [
      "task_status",
      "task_cancel",
      "create_threads",
      "t3_thread_start",
      "In your brief, tell the new agent",
      "delegated work must return a result",
      "then use `send_message",
    ]) {
      assert.notInclude(T3_CODE_ORCHESTRATION_INSTRUCTIONS, excluded);
    }
    assert.notInclude(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "cannot create a new Peer Agent yet");
  });

  it("documents structured schedules instead of JSON strings", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "structured object, never as JSON text");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, '"everyMs":3600000');
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "bindToCurrentThread=false");
  });

  it("creates mixed crews from chat and keeps coordination independent of approvals and artifacts", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "asks for a crew in ordinary chat");
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "saved personas from `list_personas` with custom seats",
    );
    assert.notInclude(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "`list_agents`");
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "Custom seats inherit your configuration by default",
    );
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "`model_selection` (instanceId, model, options)",
    );
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "`runtime_mode`");
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "Saved personas use their own configuration",
    );
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "resolved provider, model, reasoning, and access",
    );
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Captains of other crews");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Do not wait for an artifact");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "`request_crew_member`");
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "reason naming the concern and needed responsibility",
    );
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "while that request is pending");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "otherwise they queue for its next turn");
  });

  it("routes durable planning outputs into artifacts and excludes working files", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "durable, user-consumable planning outputs");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "`write_artifact`");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "`list_artifacts`");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "`read_artifact`");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "across threads and agents");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "source code, build output, logs");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "temporary scratch files");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Artifacts panel");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "outside the repository");
    // Handoffs are the one place write_artifact appends instead of replacing; the model is told.
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Artifacts under `handoffs/` are versioned");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "rather than replacing it");
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

  it("gives ACP sessions provider-neutral mode, browser, and orchestration guidance", () => {
    const injected = t3AcpPromptWithInstructions({
      prompt: "Inspect the repository.",
      state: { interactionMode: "default", hasT3Mcp: true },
    });

    assert.include(injected, "T3 Code interaction mode: Default");
    assert.include(injected, "T3 Code collaborative browser");
    assert.include(injected, "T3 Code orchestration");
    assert.include(injected, "<user_request>\nInspect the repository.\n</user_request>");
  });

  it("reinjects ACP guidance only when mode or tool availability changes", () => {
    const prompt = "Continue.";
    const defaultState = { interactionMode: "default", hasT3Mcp: true } as const;

    assert.equal(
      t3AcpPromptWithInstructions({ prompt, state: defaultState, previousState: defaultState }),
      prompt,
    );
    assert.include(
      t3AcpPromptWithInstructions({
        prompt,
        state: { ...defaultState, interactionMode: "plan" },
        previousState: defaultState,
      }),
      "T3 Code interaction mode: Plan",
    );
    const withoutMcp = t3AcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasT3Mcp: false },
    });
    assert.include(withoutMcp, "T3 Code interaction mode: Default");
    assert.notInclude(withoutMcp, "T3 Code collaborative browser");
    assert.notInclude(withoutMcp, "T3 Code orchestration");
  });
});
