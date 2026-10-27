import { assert, describe, it } from "@effect/vitest";

import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "../server/orchestrationInstructions.ts";
import { J5_ORCHESTRATION_INSTRUCTIONS } from "./orchestrationInstructions.ts";

describe("J5 orchestration instructions", () => {
  it("are what upstream's exported constant carries to every harness", () => {
    assert.strictEqual(T3_CODE_ORCHESTRATION_INSTRUCTIONS, J5_ORCHESTRATION_INSTRUCTIONS);
  });

  it("offers three ways of working that the work decides, not the user's word for them", () => {
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "Work directly when delegation would not help");
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "Use subagents when the work splits into independent assignments",
    );
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "Use a Crew when the work needs workers who must respond to each other",
    );
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      'the words in the user\'s message do not decide it, and "crew" or "subagent" in that message does not by itself pick one',
    );
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "You may reassess in the middle of the work");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "do not restart completed work");
    // The old rule made the word "crew" the trigger and forbade every other mechanism.
    assert.notInclude(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "A request to create, start, or assemble a crew",
    );
    assert.notInclude(J5_ORCHESTRATION_INSTRUCTIONS, "Never substitute");
    assert.notInclude(J5_ORCHESTRATION_INSTRUCTIONS, "asks for a crew in ordinary chat");
  });

  it("offers two ways to get help and keeps j5_spawn_agent for a standalone agent the user asks for", () => {
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "there are two ways to get it: create a subagent, or put members on a Crew",
    );
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "provider-native Subagent");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "your provider's native Subagent mechanism");
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "Use `j5_spawn_agent` only when the user explicitly asks for a standalone agent they will talk to",
    );
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "not a third way to get help");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "what should come back in that brief");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "a Crew is a group of Peer Agents");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "Use `j5_propose_crew`");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "Use `j5_list_participants`");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "later work owed by an existing participant");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "expect_reply=true");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "open an Exchange");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "continue with other work");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "`delegate_task` with persona=ID");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "`@persona:ID`");
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
      "then use `j5_send_message",
      "cannot create a new Peer Agent yet",
    ]) {
      assert.notInclude(J5_ORCHESTRATION_INSTRUCTIONS, excluded);
    }
  });

  it("uses delegate_task where the native Subagent tool falls short and once per review round", () => {
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "for same-provider work when the native Subagent tool cannot run the chosen model",
    );
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "Do not treat a native tool's model list as the full list of available subagent models: use `orchestrator_capabilities`",
    );
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "For every delegated review round, call `delegate_task` again",
    );
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "prior findings");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "Track each round by its own `taskId`");
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      'For a child task that needs a separate checkout, use `delegate_task` with `isolation:"worktree"` across any provider or model. It starts from the parent local commit and runs project setup; uncommitted edits are not copied.',
    );
  });

  it("documents structured schedules, webhooks included, instead of JSON strings", () => {
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "structured object, never as JSON text");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, '"everyMs":3600000');
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, '{"type":"webhook"}');
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "report its `webhookUrl`");
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "set `bindToCurrentThread=false` only when the user wants a fresh thread for every run",
    );
  });

  it("carries upstream's secret, thread link, and visuals guidance", () => {
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "call `request_secret`");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "Never ask for a secret in chat");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "[title](t3-thread://v1/<threadId>)");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "### Showing visuals");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "`html_preview`");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "`html_render`");
  });

  it("creates mixed crews and keeps coordination independent of approvals and artifacts", () => {
    // Codex's own tool keeps its name: it is not J5's `j5_spawn_agent`, and it makes subagents.
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "Codex's native `spawn_agent` or collaboration tools",
    );
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "create subagents, not Crew members");
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "report that blocker instead of launching replacement agents",
    );
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "saved personas from `j5_list_personas` with custom seats",
    );
    assert.notInclude(J5_ORCHESTRATION_INSTRUCTIONS, "`list_agents`");
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "Custom seats inherit your harness, model, and reasoning by default and run with full access",
    );
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "`model_selection` (instanceId, model, options)");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "`runtime_mode`");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "Saved personas use their own configuration");
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "resolved provider, model, reasoning, and access",
    );
    // #745: approval creates seats; members start on their first assignment and are reused.
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "send each member its first assignment");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "Reuse finished members for follow-up work");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "Captains of other crews");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "Do not wait for an artifact");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "`j5_request_crew_member`");
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "reason naming the concern and needed responsibility",
    );
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "it needs no approval");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "otherwise they queue for its next turn");
  });

  it("has members run their own review loops and the Captain own the outcome", () => {
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "a reviewer sends findings straight to the teammate who owns the work",
    );
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "until no finding is unresolved");
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "only for a review pass that names the commit or change it reviewed, a blocker that names what is needed, or a disagreement the members could not settle",
    );
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "no acknowledgments or progress updates");
    assert.include(
      J5_ORCHESTRATION_INSTRUCTIONS,
      "settle technical disagreements within the agreed scope yourself, and ask the user only when product intent or their judgment is needed",
    );
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "`deliveryOutcome`");
  });

  it("routes durable planning outputs into artifacts and excludes working files", () => {
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "durable, user-consumable planning outputs");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "`j5_write_artifact`");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "`j5_list_artifacts`");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "`j5_read_artifact`");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "across threads and agents");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "source code, build output, logs");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "temporary scratch files");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "Artifacts panel");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "outside the repository");
    // Handoffs are the one place j5_write_artifact appends instead of replacing; the model is told.
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "Artifacts under `handoffs/` are versioned");
    assert.include(J5_ORCHESTRATION_INSTRUCTIONS, "rather than replacing it");
  });
});
