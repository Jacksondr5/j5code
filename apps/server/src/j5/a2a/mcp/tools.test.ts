import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import {
  J5ArchiveAgentTool,
  J5SpawnAgentTool,
  J5StopAgentTool,
  J5Toolkit,
  J5_ARCHIVE_AGENT_DESCRIPTION,
  J5_SPAWN_AGENT_DESCRIPTION,
  J5_STOP_AGENT_DESCRIPTION,
} from "./tools.ts";

it("publishes the ratified single-target lifecycle contracts fail-closed", () => {
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
  assert.property(stopSchema.properties ?? {}, "client_request_id");
  assert.property(archiveSchema.properties ?? {}, "client_request_id");
  assert.property(archiveSchema.properties ?? {}, "confirmation_token");
  assert.sameMembers(Object.keys(J5Toolkit.tools), [
    "send_message",
    "list_participants",
    "spawn_agent",
    "stop_agent",
    "archive_agent",
  ]);
  assert.isFalse(Context.get(J5ArchiveAgentTool.annotations, Tool.Idempotent));
  assert.isTrue(Context.get(J5ArchiveAgentTool.annotations, Tool.Destructive));
  assert.isFalse(Context.get(J5SpawnAgentTool.annotations, Tool.Idempotent));
  assert.isFalse(Context.get(J5StopAgentTool.annotations, Tool.Idempotent));
});
