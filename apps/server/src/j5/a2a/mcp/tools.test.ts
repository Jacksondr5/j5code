import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import {
  J5SpawnAgentTool,
  J5StopAgentTool,
  J5Toolkit,
  J5_SPAWN_AGENT_DESCRIPTION,
  J5_STOP_AGENT_DESCRIPTION,
} from "./tools.ts";

it("publishes the ratified spawn and single-target stop contracts fail-closed", () => {
  assert.equal(J5SpawnAgentTool.description, J5_SPAWN_AGENT_DESCRIPTION);
  assert.equal(J5StopAgentTool.description, J5_STOP_AGENT_DESCRIPTION);
  assert.include(
    J5SpawnAgentTool.description ?? "",
    "tell the new agent what it should do first and whether it should reply to you",
  );
  assert.notProperty(J5Toolkit.tools, "archive_agent");

  const spawnSchema = Tool.getJsonSchema(J5SpawnAgentTool) as {
    readonly required?: ReadonlyArray<string>;
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  const stopSchema = Tool.getJsonSchema(J5StopAgentTool) as {
    readonly required?: ReadonlyArray<string>;
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  assert.sameMembers(
    [...(spawnSchema.required ?? [])],
    ["brief", "provider", "model", "reasoning"],
  );
  assert.sameMembers([...(stopSchema.required ?? [])], ["squadron_id", "participant_id"]);
  assert.property(spawnSchema.properties ?? {}, "client_request_id");
  assert.property(stopSchema.properties ?? {}, "client_request_id");
  assert.isFalse(Context.get(J5SpawnAgentTool.annotations, Tool.Idempotent));
  assert.isFalse(Context.get(J5StopAgentTool.annotations, Tool.Idempotent));
});
