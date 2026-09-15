import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import { A2A_SEND_TOOL_DESCRIPTION } from "../EnvelopeFormatter.ts";
import { J5_CLAUDE_MCP_ALLOWED_TOOLS } from "./claudeAllowedTools.ts";
import {
  J5ArchiveAgentTool,
  J5SendMessageTool,
  J5SpawnAgentTool,
  J5StopAgentTool,
  J5Toolkit,
  J5_ARCHIVE_AGENT_DESCRIPTION,
  J5_SPAWN_AGENT_DESCRIPTION,
  J5_STOP_AGENT_DESCRIPTION,
} from "./tools.ts";

it("publishes the ratified single-target lifecycle contracts fail-closed", () => {
  assert.equal(J5SendMessageTool.description, A2A_SEND_TOOL_DESCRIPTION);
  assert.include(
    J5SendMessageTool.description ?? "",
    "To the human, only an ask: a plain send to a person is refused",
  );
  assert.equal(J5ArchiveAgentTool.description, J5_ARCHIVE_AGENT_DESCRIPTION);
  assert.equal(J5SpawnAgentTool.description, J5_SPAWN_AGENT_DESCRIPTION);
  assert.equal(J5StopAgentTool.description, J5_STOP_AGENT_DESCRIPTION);
  const sp4BriefSteering =
    "In your brief, tell the new agent what it should do first and whether it should reply to you.";
  assert.equal(J5SpawnAgentTool.description?.split(sp4BriefSteering).length, 2);
  assert.notInclude(J5SpawnAgentTool.description ?? "", "send_message");
  assert.notInclude(J5SpawnAgentTool.description ?? "", "expect_reply");
  assert.include(J5ArchiveAgentTool.description ?? "", "confirmation_token");
  assert.include(J5ArchiveAgentTool.description ?? "", "one Peer Agent");
  assert.notInclude(J5ArchiveAgentTool.description ?? "", "cascade");
  assert.notInclude(J5ArchiveAgentTool.description ?? "", "descendant");

  const spawnSchema = Tool.getJsonSchema(J5SpawnAgentTool) as {
    readonly required?: ReadonlyArray<string>;
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  const stopSchema = Tool.getJsonSchema(J5StopAgentTool) as {
    readonly required?: ReadonlyArray<string>;
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  const archiveSchema = Tool.getJsonSchema(J5ArchiveAgentTool) as {
    readonly required?: ReadonlyArray<string>;
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  assert.sameMembers(
    [...(spawnSchema.required ?? [])],
    ["brief", "provider", "model", "reasoning"],
  );
  assert.sameMembers([...(stopSchema.required ?? [])], ["squadron_id", "participant_id"]);
  assert.sameMembers([...(archiveSchema.required ?? [])], ["squadron_id", "participant_id"]);
  assert.property(spawnSchema.properties ?? {}, "client_request_id");
  assert.property(spawnSchema.properties ?? {}, "agent");
  assert.include(J5SpawnAgentTool.description ?? "", "one of that agent's declared routes");
  assert.property(stopSchema.properties ?? {}, "client_request_id");
  assert.property(archiveSchema.properties ?? {}, "client_request_id");
  assert.property(archiveSchema.properties ?? {}, "confirmation_token");
  assert.sameMembers(Object.keys(J5Toolkit.tools), [
    "send_message",
    "list_participants",
    "spawn_agent",
    "stop_agent",
    "archive_agent",
    "clear_own_ask",
    "list_squadrons",
    "join_squadron",
  ]);
  // Declared handoffs are written by the agent itself with the project write_artifact tool
  // (artifacts live in application storage, not the sandboxed workspace), so a read-only Claude
  // persona must have it pre-approved beside the J5 verbs, and the provider-native Subagent verbs
  // ride along so a refused spawner still has a way to get help. The artifact reads are upstream's.
  assert.sameMembers(
    [...J5_CLAUDE_MCP_ALLOWED_TOOLS],
    [
      ...Object.keys(J5Toolkit.tools).map((name) => `mcp__t3-code__${name}`),
      "mcp__t3-code__write_artifact",
      "mcp__t3-code__delegate_task",
      "mcp__t3-code__task_status",
      "mcp__t3-code__task_cancel",
    ],
  );
  assert.isFalse(Context.get(J5ArchiveAgentTool.annotations, Tool.Idempotent));
  assert.isTrue(Context.get(J5ArchiveAgentTool.annotations, Tool.Destructive));
  assert.isFalse(Context.get(J5SpawnAgentTool.annotations, Tool.Idempotent));
  assert.isFalse(Context.get(J5StopAgentTool.annotations, Tool.Idempotent));
});
