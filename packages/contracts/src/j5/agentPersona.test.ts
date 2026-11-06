import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { OrchestrationV2Command, OrchestrationV2PublicCommand } from "../orchestrationV2.ts";
import {
  AgentPersonaCreateInput,
  AgentPersonaEditInput,
  AgentPersonaId,
  OrchestrationV2AgentPersonaAssignment,
  OrchestrationV2AgentPersonaRequest,
} from "./agentPersona.ts";

const decodeOrchestrationV2Command = Schema.decodeUnknownSync(OrchestrationV2Command);
const decodeOrchestrationV2PublicCommand = Schema.decodeUnknownSync(OrchestrationV2PublicCommand);
const decodePersonaId = Schema.decodeUnknownSync(AgentPersonaId);
const decodePersonaAssignment = Schema.decodeUnknownSync(OrchestrationV2AgentPersonaAssignment);
const decodePersonaRequest = Schema.decodeUnknownSync(OrchestrationV2AgentPersonaRequest);
const decodePersonaCreate = Schema.decodeUnknownSync(AgentPersonaCreateInput);
const decodePersonaEdit = Schema.decodeUnknownSync(AgentPersonaEditInput);

describe("agent persona contracts", () => {
  it("accepts one or many ordered instance entries and rejects an empty list", () => {
    const input = {
      id: "ordered",
      displayName: "Ordered",
      description: "Ordered models",
      instructions: "Work",
      access: "read-only",
      modelRoute: [
        {
          instanceId: "codex",
          model: "first",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      ],
    };
    expect(decodePersonaCreate(input).modelRoute).toEqual(input.modelRoute);
    const many = {
      ...input,
      modelRoute: [
        ...input.modelRoute,
        { instanceId: "claudeAgent", model: "second" },
        { instanceId: "codex-other", model: "third" },
      ],
    };
    expect(decodePersonaCreate(many).modelRoute).toEqual(many.modelRoute);
    expect(() => decodePersonaCreate({ ...input, modelRoute: [] })).toThrow();
    expect(() =>
      decodePersonaCreate({
        ...input,
        modelRoute: [{ provider: "codex", model: "first", reasoningEffort: "high" }],
      }),
    ).toThrow();
    expect(() =>
      decodePersonaCreate({
        ...input,
        modelRoute: [{ instanceId: "codex", model: "first", reasoningEffort: "high" }],
      }),
    ).toThrow();
  });

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
    const override = {
      ...assignment,
      resolvedRoute: "override",
      runtimeModeOverride: "full-access",
    };
    expect(decodePersonaAssignment(override)).toEqual(override);

    expect(() =>
      decodePersonaAssignment({
        ...assignment,
        definitionDigest: "../escape",
      }),
    ).toThrow();
    const { definitionDigest: _digest, displayName: _name, ...legacy } = assignment;
    expect(decodePersonaAssignment(legacy).definitionDigest).toBeUndefined();
  });

  it("records who picked a persona, and reads assignments made before that", () => {
    const assignment = {
      personaId: "operator",
      definitionVersion: 1,
      authorityPolicy: "full-access",
      resolvedRoute: "primary",
      resolvedDriver: "codex",
      resolvedModelSelection: { instanceId: "codex", model: "gpt-5.6-terra" },
    };
    expect(decodePersonaAssignment(assignment).pickSource).toBeUndefined();
    for (const pickSource of [
      { kind: "person" },
      { kind: "agent" },
      { kind: "allow-once", waived: "model-not-eligible" },
      { kind: "allow-once", waived: "access-above-caller" },
    ])
      expect(decodePersonaAssignment({ ...assignment, pickSource }).pickSource).toEqual(pickSource);
    expect(() =>
      decodePersonaAssignment({ ...assignment, pickSource: { kind: "allow-once" } }),
    ).toThrow();
  });

  it("reads any reported policy but accepts only known ones from clients", () => {
    const assignment = {
      personaId: "operator",
      definitionVersion: 1,
      authorityPolicy: "full-access",
      resolvedRoute: "primary",
      resolvedDriver: "codex",
      resolvedModelSelection: { instanceId: "codex", model: "gpt-5.6-terra" },
    };
    expect(decodePersonaAssignment(assignment)).toEqual(assignment);
    // A newer server's policy reaches older clients intact so they can show it as unsupported.
    expect(decodePersonaAssignment({ ...assignment, authorityPolicy: "root-access" })).toEqual({
      ...assignment,
      authorityPolicy: "root-access",
    });

    expect(decodePersonaRequest({ personaId: "operator", authorityPolicy: "full-access" })).toEqual(
      { personaId: "operator", authorityPolicy: "full-access" },
    );
    expect(() =>
      decodePersonaRequest({ personaId: "operator", authorityPolicy: "root-access" }),
    ).toThrow();
    const create = {
      id: "operator",
      displayName: "Operator",
      description: "Runs things.",
      instructions: "Run things.",
      access: "root-access",
      modelRoute: [
        { driver: "codex", model: "gpt-5.6-terra", reasoningEffort: "high" },
        { driver: "codex", model: "gpt-5.6-terra", reasoningEffort: "high" },
      ],
    };
    expect(() => decodePersonaCreate(create)).toThrow();
    expect(decodePersonaCreate({ ...create, access: "full-access" }).access).toBe("full-access");
  });

  it("keeps server-issued command assignments on known policies", () => {
    const assignment = {
      personaId: "operator",
      definitionVersion: 1,
      authorityPolicy: "full-access",
      resolvedRoute: "primary",
      resolvedDriver: "codex",
      resolvedModelSelection: { instanceId: "codex", model: "gpt-5.6-terra" },
    };
    const create = {
      type: "thread.create",
      createdBy: "agent",
      creationSource: "mcp",
      commandId: "command-operator",
      threadId: "thread-operator",
      projectId: "project-operator",
      title: "Operator",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-terra" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      agentPersonaAssignment: assignment,
    };
    expect(decodeOrchestrationV2Command(create).type).toBe("thread.create");
    expect(() =>
      decodeOrchestrationV2Command({
        ...create,
        agentPersonaAssignment: { ...assignment, authorityPolicy: "root-access" },
      }),
    ).toThrow();
    const delegated = {
      type: "delegated_task.request",
      createdBy: "agent",
      creationSource: "mcp",
      commandId: "command-delegate",
      parentThreadId: "thread-parent",
      parentRunId: "run-parent",
      parentNodeId: "node-parent",
      task: "Do it.",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-terra" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      agentPersonaAssignment: assignment,
    };
    expect(decodeOrchestrationV2Command(delegated).type).toBe("delegated_task.request");
    expect(() =>
      decodeOrchestrationV2Command({
        ...delegated,
        agentPersonaAssignment: { ...assignment, authorityPolicy: "root-access" },
      }),
    ).toThrow();
  });
});

it("keeps indexed assignments readable by the legacy assignment schema", () => {
  const legacy = Schema.Struct({
    ...OrchestrationV2AgentPersonaAssignment.fields,
    resolvedEntryIndex: Schema.optional(Schema.Never),
  });
  const raw = {
    personaId: "ordered",
    definitionVersion: 1,
    authorityPolicy: "read-only",
    resolvedRoute: "fallback",
    resolvedDriver: "codex",
    resolvedEntryIndex: 2,
    resolvedModelSelection: { instanceId: "codex", model: "third" },
  };
  const { resolvedEntryIndex: _newField, ...legacyFields } = legacy.fields;
  const oldReader = Schema.Struct(legacyFields);
  expect(Schema.decodeUnknownSync(oldReader)(raw).resolvedRoute).toBe("fallback");
  expect(decodePersonaAssignment(raw).resolvedEntryIndex).toBe(2);
});

it("accepts only three access levels for new persona writes", () => {
  const details = {
    id: "reviewer",
    personaId: "reviewer",
    expectedDigest: "a".repeat(64),
    displayName: "Reviewer",
    description: "Review changes",
    instructions: "Review",
    modelRoute: [{ instanceId: "codex", model: "review-model" }],
  };
  for (const schema of [AgentPersonaCreateInput, AgentPersonaEditInput]) {
    const decode = Schema.decodeUnknownSync(schema);
    for (const access of ["read-only", "workspace-write", "full-access"])
      expect(decode({ ...details, access }).access).toBe(access);
    for (const access of [undefined, "critic-review", "critic-fix", "diagnostic", "publish-only"])
      expect(() => decode({ ...details, access, authorityPolicy: "read-only" })).toThrow();
  }
});

it("rejects an old-client edit without access during decoding", () => {
  expect(() =>
    decodePersonaEdit({
      personaId: "reviewer",
      expectedDigest: "a".repeat(64),
      displayName: "Reviewer",
      description: "Review changes",
      instructions: "Review",
      authorityPolicy: "read-only",
      modelRoute: [
        { driver: "codex", model: "first", reasoningEffort: "high" },
        { driver: "codex", model: "second", reasoningEffort: "high" },
      ],
    }),
  ).toThrow(/access/);
});
