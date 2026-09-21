import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import { A2A_SEND_TOOL_DESCRIPTION } from "../EnvelopeFormatter.ts";
import { J5OrchestratorSurface } from "./orchestratorSurface.ts";
import { J5_CLAUDE_MCP_ALLOWED_TOOLS } from "./claudeAllowedTools.ts";
import {
  J5ArchiveAgentTool,
  J5ArchiveCrewTool,
  J5ProposeCrewTool,
  J5RequestCrewMemberTool,
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
    "list_agents",
    "list_participants",
    "propose_crew",
    "request_crew_member",
    "spawn_agent",
    "stop_agent",
    "stop_crew",
    "archive_agent",
    "archive_crew",
    "clear_own_ask",
    "list_squadrons",
    "join_squadron",
  ]);
  assert.include(J5ArchiveCrewTool.description ?? "", "only as a unit");
  assert.include(J5ArchiveCrewTool.description ?? "", "confirmation_token");
  assert.include(J5ArchiveCrewTool.description ?? "", "check with the user");
  assert.isTrue(Context.get(J5ArchiveCrewTool.annotations, Tool.Destructive));
  // Proposals only file a human-gated request, and must say so: read-only Captains run with
  // approval policy never and have refused the brief when the gate looked like a shell approval.
  assert.isFalse(Context.get(J5ProposeCrewTool.annotations, Tool.Destructive));
  assert.isFalse(Context.get(J5RequestCrewMemberTool.annotations, Tool.Destructive));
  assert.include(J5ProposeCrewTool.description ?? "", "including approval policy never");
  assert.include(J5RequestCrewMemberTool.description ?? "", "including approval policy never");
  // Declared handoffs are written by the seat itself with the project write_artifact tool
  // (artifacts live in application storage, not the sandboxed workspace), so a read-only Claude
  // persona must have it pre-approved beside the J5 verbs. The artifact reads are upstream's.
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

// Claude Code drops EVERY tool of an MCP server when one tool's input schema has no top-level
// `type: "object"` (verified 2026-09-10 with a probe server: a single top-level `anyOf` tool made
// the whole server's inventory vanish while it still reported "connected"). `Schema.Struct({})`
// encodes as exactly that anyOf, which is how `list_agents` silently took the whole t3-code
// toolkit away from every Claude thread. No-input tools must omit `parameters` instead.
it("publishes every tool with a top-level object input schema", () => {
  for (const tool of [
    ...Object.values(J5Toolkit.tools),
    ...Object.values(J5OrchestratorSurface.tools),
  ]) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly anyOf?: unknown;
    };
    assert.equal(schema.type, "object", `${tool.name} must publish type: "object"`);
    assert.isUndefined(schema.anyOf, `${tool.name} must not publish a top-level anyOf`);
  }
});
