import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { OrchestrationV2Command, OrchestrationV2PublicCommand } from "../orchestrationV2.ts";
import { AgentPersonaId, OrchestrationV2AgentPersonaAssignment } from "./agentPersona.ts";

const decodeOrchestrationV2Command = Schema.decodeUnknownSync(OrchestrationV2Command);
const decodeOrchestrationV2PublicCommand = Schema.decodeUnknownSync(OrchestrationV2PublicCommand);
const decodePersonaId = Schema.decodeUnknownSync(AgentPersonaId);
const decodePersonaAssignment = Schema.decodeUnknownSync(OrchestrationV2AgentPersonaAssignment);

describe("agent persona contracts", () => {
  it("rejects server-owned persona assignments on the public command boundary", () => {
    const command = {
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: "command-public-persona",
      threadId: "thread-public-persona",
      projectId: "project-public-persona",
      title: "Public persona",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-terra" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      agentPersonaAssignment: {
        personaId: "scout",
        definitionVersion: 1,
        authorityPolicy: "publish-only",
        resolvedRoute: "primary",
        resolvedDriver: "codex",
        resolvedModelSelection: { instanceId: "codex", model: "gpt-5.6-terra" },
      },
    };

    expect(() => decodeOrchestrationV2PublicCommand(command)).toThrow(
      "Resolved agent persona assignments are server-owned.",
    );
    expect(decodeOrchestrationV2Command(command).type).toBe("thread.create");
  });

  it("accepts custom persona ids and validates snapshot references without requiring them on legacy assignments", () => {
    expect(decodePersonaId("team-researcher")).toBe("team-researcher");
    expect(() => decodePersonaId("../escape")).toThrow();
    const assignment = {
      personaId: "team-researcher",
      definitionVersion: 4,
      displayName: "Team Researcher",
      definitionDigest: "a".repeat(64),
      authorityPolicy: "read-only",
      resolvedRoute: "primary",
      resolvedDriver: "codex",
      resolvedModelSelection: { instanceId: "codex", model: "research-model" },
    };
    expect(decodePersonaAssignment(assignment)).toEqual(assignment);
    expect(() =>
      decodePersonaAssignment({
        ...assignment,
        definitionDigest: "../escape",
      }),
    ).toThrow();
    const { definitionDigest: _digest, displayName: _name, ...legacy } = assignment;
    expect(decodePersonaAssignment(legacy).definitionDigest).toBeUndefined();
  });
});
