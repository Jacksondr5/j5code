import { assert, describe, it } from "@effect/vitest";

import {
  codexApplicationContext,
  T3_CODE_BROWSER_TOOL_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationPromptForFirstRun,
  t3OrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

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
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "`delegate_task` with persona=ID");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "`@persona:ID`");
    // Upstream's raw thread tools stay hidden, so its guidance for them is not ported.
    for (const excluded of [
      "task_status",
      "task_cancel",
      "create_threads",
      "t3_thread_start",
      "t3_thread_send",
      "t3_thread_launch",
      "workspace strategy",
      "workspaceStrategy",
      "In your brief, tell the new agent",
      "delegated work must return a result",
      "then use `send_message",
      "cannot create a new Peer Agent yet",
    ]) {
      assert.notInclude(T3_CODE_ORCHESTRATION_INSTRUCTIONS, excluded);
    }
  });

  it("uses delegate_task where the native Subagent tool falls short and once per review round", () => {
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "for same-provider work when the native Subagent tool cannot run the chosen model",
    );
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "Do not treat a native tool's model list as the full list of available subagent models: use `orchestrator_capabilities`",
    );
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "For every delegated review round, call `delegate_task` again",
    );
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "prior findings");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Track each round by its own `taskId`");
  });

  it("documents structured schedules, webhooks included, instead of JSON strings", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "structured object, never as JSON text");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, '"everyMs":3600000');
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, '{"type":"webhook"}');
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "report its `webhookUrl`");
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "set `bindToCurrentThread=false` only when the user wants a fresh thread for every run",
    );
  });

  it("carries upstream's secret, thread link, and visuals guidance", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "call `request_secret`");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Never ask for a secret in chat");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "[title](t3-thread://v1/<threadId>)");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "### Showing visuals");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "`html_preview`");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "`html_render`");
  });

  it("tells agents how to share the browser with the user and when to leave it", () => {
    assert.include(T3_CODE_BROWSER_TOOL_INSTRUCTIONS, "J5 Code collaborative browser");
    assert.include(T3_CODE_BROWSER_TOOL_INSTRUCTIONS, "first call `preview_status`");
    assert.include(T3_CODE_BROWSER_TOOL_INSTRUCTIONS, "including tabs the user opened");
    assert.include(T3_CODE_BROWSER_TOOL_INSTRUCTIONS, "only while its owner is `unclaimed`");
    assert.include(T3_CODE_BROWSER_TOOL_INSTRUCTIONS, "pass `profileId`");
    assert.include(T3_CODE_BROWSER_TOOL_INSTRUCTIONS, "have failed twice on the same step");
  });

  it("creates mixed crews from chat and keeps coordination independent of approvals and artifacts", () => {
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "A request to create, start, or assemble a crew must go through `propose_crew` on the `t3-code` MCP server",
    );
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "Never substitute provider-native Subagents, `delegate_task`, or individual `spawn_agent` calls for a requested crew",
    );
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "report that blocker instead of launching replacement agents",
    );
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "asks for a crew in ordinary chat");
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "saved personas from `list_personas` with custom seats",
    );
    assert.notInclude(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "`list_agents`");
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "Custom seats inherit your harness, model, and reasoning by default and run with full access",
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

    assert.include(injected, "J5 Code interaction mode: Default");
    assert.include(injected, "J5 Code collaborative browser");
    assert.include(injected, "J5 Code orchestration");
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
      "J5 Code interaction mode: Plan",
    );
    const withoutMcp = t3AcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasT3Mcp: false },
    });
    assert.include(withoutMcp, "J5 Code interaction mode: Default");
    assert.notInclude(withoutMcp, "J5 Code collaborative browser");
    assert.notInclude(withoutMcp, "J5 Code orchestration");
  });

  it("leaves a native slash command at the start of an ACP prompt", () => {
    assert.equal(
      t3AcpPromptWithInstructions({
        prompt: "/compact",
        state: { interactionMode: "default", hasT3Mcp: true },
      }),
      "/compact",
    );
  });
});

describe("codexApplicationContext", () => {
  it("spreads J5's orchestration text over numbered keys that each fit Codex's entry cap", () => {
    const entries = codexApplicationContext(
      "t3_code_orchestration",
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
    );
    const keys = Object.keys(entries);

    assert.isAbove(keys.length, 1);
    assert.deepEqual(
      keys,
      keys.map((_, index) =>
        index === 0 ? "t3_code_orchestration" : `t3_code_orchestration_${index + 1}`,
      ),
    );
    for (const entry of Object.values(entries)) {
      assert.equal(entry.kind, "application");
      assert.isAtMost(Buffer.byteLength(entry.value), 3_600);
    }
    assert.equal(
      Object.values(entries)
        .map((entry) => entry.value)
        .join("\n"),
      T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim(),
    );
  });

  it("keeps short text in the one given key and sends nothing for no text", () => {
    assert.deepEqual(codexApplicationContext("j5_agent_persona", "  Builder instructions\n"), {
      j5_agent_persona: { kind: "application", value: "Builder instructions" },
    });
    assert.deepEqual(codexApplicationContext("j5_agent_persona", undefined), {});
    assert.deepEqual(codexApplicationContext("j5_agent_persona", "  \n"), {});
  });
});
