import {
  BUILT_IN_AGENT_PERSONA_IDS,
  AgentPersonaImportConflictError,
  type AgentPersonaImportInput,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2AgentPersonaCatalog,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  prepareAgentPersonaImport,
  importAgentPersonasWithConfirmation,
  agentPersonaModelChoices,
  presentAgentPersonaAssignment,
  presentAgentPersonaCatalog,
} from "./agentPersonas.ts";

const catalog: OrchestrationV2AgentPersonaCatalog = {
  personas: BUILT_IN_AGENT_PERSONA_IDS.map((personaId, index) => ({
    personaId,
    definitionVersion: 1,
    displayName: personaId,
    description: `${personaId} description`,
    acceptedInput: `${personaId} input`,
    outputArtifact: "ContextBrief",
    defaultAuthorityPolicy: "read-only",
    allowedAuthorityPolicies: ["read-only"],
    availability:
      index === 0
        ? {
            status: "available",
            resolvedRoute: "fallback",
            resolvedDriver: ProviderDriverKind.make("codex"),
            resolvedModelSelection: {
              instanceId: ProviderInstanceId.make("remote-codex"),
              model: "server-selected-model",
            },
          }
        : { status: "unavailable", reason: "routes-unavailable" },
  })),
};

describe("agent persona catalog presentation", () => {
  it("presents a durable assignment with its immutable provider route", () => {
    expect(
      presentAgentPersonaAssignment({
        personaId: "critic",
        definitionVersion: 1,
        authorityPolicy: "critic-fix",
        resolvedRoute: "fallback",
        resolvedDriver: ProviderDriverKind.make("codex"),
        resolvedModelSelection: {
          instanceId: ProviderInstanceId.make("remote-codex"),
          model: "gpt-5.6-terra",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      }),
    ).toEqual({
      personaLabel: "Critic · Fix",
      routeLabel: "Codex · gpt-5.6-terra · high",
    });
  });

  it("preserves all eleven server-provided personas for every client", () => {
    expect(presentAgentPersonaCatalog(catalog).map(({ personaId }) => personaId)).toEqual([
      ...BUILT_IN_AGENT_PERSONA_IDS,
    ]);
  });

  it("presents the server-resolved remote route without recalculating it", () => {
    expect(presentAgentPersonaCatalog(catalog)[0]).toMatchObject({
      availability: "available",
      availabilityLabel: "Available",
      route: "Codex · server-selected-model · fallback",
    });
  });

  it("presents unavailable personas as clearly blocked", () => {
    expect(presentAgentPersonaCatalog(catalog)[1]).toMatchObject({
      availability: "blocked",
      availabilityLabel: "Blocked",
      route: "Primary and fallback models unavailable",
    });
  });

  it("distinguishes an unenforceable authority boundary from missing models", () => {
    const authorityBlocked = {
      personas: [
        {
          ...catalog.personas[1]!,
          availability: {
            status: "unavailable" as const,
            reason: "authority-not-enforceable" as const,
          },
        },
      ],
    };

    expect(presentAgentPersonaCatalog(authorityBlocked)[0]?.route).toBe(
      "Required authority is not yet enforceable",
    );
  });
});

it("presents custom library ids and immutable display names on every client", () => {
  const custom = {
    ...catalog.personas[0]!,
    personaId: "team-researcher",
    displayName: "Team Researcher",
    outputArtifact: "TeamBrief",
  };
  expect(presentAgentPersonaCatalog({ personas: [custom] })[0]).toMatchObject({
    personaId: "team-researcher",
    displayName: "Team Researcher",
    outputArtifact: "TeamBrief",
  });
  expect(
    presentAgentPersonaAssignment({
      personaId: custom.personaId,
      displayName: "Original Researcher",
      definitionVersion: 2,
      definitionDigest: "a".repeat(64),
      authorityPolicy: "read-only",
      resolvedRoute: "primary",
      resolvedDriver: ProviderDriverKind.make("codex"),
      resolvedModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "research-model",
      },
    }).personaLabel,
  ).toBe("Original Researcher");
  expect(presentAgentPersonaCatalog({ personas: [] })).toEqual([]);
});

describe("persona import selection", () => {
  const file = (name: string, content = "{}", size = content.length) => ({
    name,
    size,
    text: async () => content,
  });
  it("includes nested YAML definitions and skips JSON files and documentation unread", async () => {
    const unread = (name: string) => ({
      name,
      size: 1,
      text: async () => {
        throw new Error("Must not read");
      },
    });
    expect(
      await prepareAgentPersonaImport([
        file("team/one/agent.yaml", "one"),
        file("team/two/agent.YAML", "two"),
        file("team/three/agent.yml", "three"),
        file("team/four/agent.YML", "four"),
        unread("team/legacy/agent.json"),
        unread("team/README.md"),
      ]),
    ).toEqual([
      { name: "team/one/agent.yaml", content: "one" },
      { name: "team/two/agent.YAML", content: "two" },
      { name: "team/three/agent.yml", content: "three" },
      { name: "team/four/agent.YML", content: "four" },
    ]);
  });
  it("imports only the selected individual definition", async () => {
    expect(await prepareAgentPersonaImport([file("agent.yaml", "selected")])).toEqual([
      { name: "agent.yaml", content: "selected" },
    ]);
  });
  it("reports empty folders and file limits before reading oversized selections", async () => {
    await expect(prepareAgentPersonaImport([file("README.md")])).rejects.toThrow("No YAML");
    await expect(prepareAgentPersonaImport([file("big.yaml", "", 65537)])).rejects.toThrow(
      "64 KiB",
    );
    await expect(
      prepareAgentPersonaImport(Array.from({ length: 51 }, () => file("agent.yaml"))),
    ).rejects.toThrow("at most 50");
  });
  it("identifies removable imports while treating older catalog entries as source definitions", () => {
    const persona = catalog.personas[0]!;
    expect(presentAgentPersonaCatalog({ personas: [persona] })[0]?.imported).toBe(false);
    expect(
      presentAgentPersonaCatalog({ personas: [{ ...persona, imported: true }] })[0]?.imported,
    ).toBe(true);
  });
});

it("shows disabled imports as off and distinguishes them from enabled agents with unavailable models", () => {
  const persona = catalog.personas[1]!;
  const disabled = presentAgentPersonaCatalog({
    personas: [
      { ...persona, imported: true, availability: { status: "unavailable", reason: "disabled" } },
    ],
  })[0];
  expect(disabled).toMatchObject({
    imported: true,
    enabled: false,
    availability: "disabled",
    availabilityLabel: "Disabled",
    route: "Disabled for new launches",
  });
  expect(presentAgentPersonaCatalog({ personas: [persona] })[0]).toMatchObject({
    enabled: true,
    availability: "blocked",
  });
});

it("offers editing only for imported entries with server-provided editable details", () => {
  const persona = catalog.personas[0]!;
  expect(presentAgentPersonaCatalog({ personas: [persona] })[0]?.edit).toBeNull();
  const modelRoute = [
    { driver: "codex", model: "custom-model", reasoningEffort: "high" },
    { driver: "claudeAgent", model: "fallback-model", reasoningEffort: "medium" },
  ] as const;
  expect(
    presentAgentPersonaCatalog({
      personas: [
        { ...persona, imported: true, editable: { definitionDigest: "a".repeat(64), modelRoute } },
      ],
    })[0]?.edit,
  ).toEqual({
    personaId: persona.personaId,
    expectedDigest: "a".repeat(64),
    displayName: persona.displayName,
    description: persona.description,
    authorityPolicy: persona.defaultAuthorityPolicy,
    modelRoute,
  });
  const choices = agentPersonaModelChoices([], modelRoute);
  expect(choices).toHaveLength(2);
  expect(choices.find(({ target }) => target.driver === "codex")?.efforts).toEqual(["high"]);
  expect(choices.every(({ label }) => label.includes("not advertised"))).toBe(true);
});

it("uses the selected environment's advertised models and reasoning options without duplicating instances", () => {
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make("remote-codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-08T00:00:00.000Z",
    availability: "available",
    slashCommands: [],
    skills: [],
    models: [
      {
        slug: "team-model",
        name: "Team model",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select",
              options: [
                { id: "xhigh", label: "Extra high" },
                { id: "high", label: "High" },
                { id: "medium", label: "Medium" },
                { id: "minimal", label: "Minimal" },
                { id: "max", label: "Max" },
              ],
            },
          ],
        },
      },
    ],
  };
  const choices = agentPersonaModelChoices(
    [provider, { ...provider, instanceId: ProviderInstanceId.make("second-codex") }],
    [{ driver: "codex", model: "team-model", reasoningEffort: "xhigh" }],
  );
  for (const unavailable of [
    { ...provider, auth: { status: "unauthenticated" as const } },
    { ...provider, auth: { status: "unknown" as const } },
    { ...provider, enabled: false },
    { ...provider, installed: false },
  ]) {
    expect(agentPersonaModelChoices([unavailable], [])).toEqual([]);
    const configured = agentPersonaModelChoices([unavailable], [choices[0]!.target]);
    expect(configured).toHaveLength(1);
    expect(configured[0]?.available).toBe(false);
  }
  expect(choices).toHaveLength(1);
  expect(choices[0]).toMatchObject({
    available: true,
    label: "Codex · team-model",
    target: { driver: "codex", model: "team-model", reasoningEffort: "high" },
    efforts: ["xhigh", "high", "medium", "minimal", "max"],
  });
});

it("retains unadvertised models and their configured reasoning levels", () => {
  const current = [
    { driver: "codex", model: "legacy-model", reasoningEffort: "xhigh" },
    { driver: "claudeAgent", model: "custom-model", reasoningEffort: "low" },
  ] as const;
  const choices = agentPersonaModelChoices([], current);
  expect(choices.find(({ target }) => target.model === "legacy-model")).toMatchObject({
    target: current[0],
    efforts: ["xhigh"],
  });
  expect(choices.find(({ target }) => target.model === "custom-model")?.efforts).toEqual(["low"]);
  expect(current[0].reasoningEffort).toBe("xhigh");
});

it("merges all configured reasoning levels for a shared unadvertised model", () => {
  const choices = agentPersonaModelChoices(
    [],
    [
      { driver: "codex", model: "custom-model", reasoningEffort: "low" },
      { driver: "codex", model: "custom-model", reasoningEffort: "high" },
      { driver: "codex", model: "custom-model", reasoningEffort: "xhigh" },
    ],
  );
  expect(choices).toHaveLength(1);
  expect(choices[0]).toMatchObject({
    target: { driver: "codex", model: "custom-model", reasoningEffort: "xhigh" },
    efforts: ["low", "high", "xhigh"],
  });
});

describe("import replacement confirmation", () => {
  const files = [{ name: "agent.yaml", content: "selected content" }];
  const conflict = new AgentPersonaImportConflictError({
    message: "Already exists",
    conflicts: [{ personaId: "scout", displayName: "Scout", definitionDigest: "a".repeat(64) }],
  });

  it("imports a new selection without showing confirmation", async () => {
    let prompts = 0;
    const result = await importAgentPersonasWithConfirmation(
      files,
      async (input) => {
        expect(input).toEqual({ files, replaceExisting: false });
        return { importedIds: ["scout"] };
      },
      async () => {
        prompts++;
        return null;
      },
    );
    expect(result?.importedIds).toEqual(["scout"]);
    expect(prompts).toBe(0);
  });

  it("cancels without sending a replacement request", async () => {
    const requests: AgentPersonaImportInput[] = [];
    const result = await importAgentPersonasWithConfirmation(
      files,
      async (input) => {
        requests.push(input);
        throw conflict;
      },
      async () => null,
    );
    expect(result).toBeNull();
    expect(requests).toEqual([{ files, replaceExisting: false }]);
  });

  it("retries the same files with the exact conflicts the user approved", async () => {
    const requests: AgentPersonaImportInput[] = [];
    const result = await importAgentPersonasWithConfirmation(
      files,
      async (input) => {
        requests.push(input);
        if (!input.replaceExisting) throw conflict;
        return { importedIds: ["scout"] };
      },
      async (error) => {
        expect(error.conflicts).toEqual(conflict.conflicts);
        return error.conflicts;
      },
    );
    expect(requests[1]).toEqual({
      files,
      replaceExisting: true,
      confirmedConflicts: conflict.conflicts,
      skippedPersonaIds: [],
    });
    expect(result?.importedIds).toEqual(["scout"]);
  });

  it("asks again on changed conflicts and propagates unrelated failures without prompting", async () => {
    const changed = new AgentPersonaImportConflictError({
      message: "Changed",
      conflicts: [{ ...conflict.conflicts[0]!, definitionDigest: "b".repeat(64) }],
    });
    let requests = 0;
    let prompts = 0;
    const result = await importAgentPersonasWithConfirmation(
      files,
      async () => {
        throw requests++ === 0 ? conflict : changed;
      },
      async (error) => (++prompts === 1 ? error.conflicts : null),
    );
    expect(result).toBeNull();
    expect(requests).toBe(2);
    expect(prompts).toBe(2);
    await expect(
      importAgentPersonasWithConfirmation(
        files,
        async () => {
          throw new Error("Invalid JSON");
        },
        async () => {
          throw new Error("Should not prompt");
        },
      ),
    ).rejects.toThrow("Invalid JSON");
  });
});

it("retains skipped agents through fresh confirmation and accepts an empty replacement selection", async () => {
  const files = [{ name: "folder/agent.yaml", content: "selected content" }];
  const first = new AgentPersonaImportConflictError({
    message: "Already exists",
    conflicts: [
      { personaId: "keep", displayName: "Keep", definitionDigest: "a".repeat(64) },
      { personaId: "replace", displayName: "Replace", definitionDigest: "b".repeat(64) },
    ],
  });
  const changed = new AgentPersonaImportConflictError({
    message: "Changed",
    conflicts: [{ ...first.conflicts[1]!, definitionDigest: "c".repeat(64) }],
  });
  const requests: AgentPersonaImportInput[] = [];
  let prompts = 0;
  const result = await importAgentPersonasWithConfirmation(
    files,
    async (input) => {
      requests.push(input);
      if (requests.length === 1) throw first;
      if (requests.length === 2) throw changed;
      return { importedIds: ["new-agent"] };
    },
    async (error) =>
      ++prompts === 1 ? error.conflicts.filter(({ personaId }) => personaId === "replace") : [],
  );
  expect(requests[1]).toEqual({
    files,
    replaceExisting: true,
    confirmedConflicts: [first.conflicts[1]],
    skippedPersonaIds: ["keep"],
  });
  expect(requests[2]).toEqual({
    files,
    replaceExisting: true,
    confirmedConflicts: [],
    skippedPersonaIds: ["keep", "replace"],
  });
  expect(result?.importedIds).toEqual(["new-agent"]);
});

it("presents removed source agents as restorable and never launchable", () => {
  const persona = catalog.personas[1]!;
  const removed = presentAgentPersonaCatalog({
    personas: [
      { ...persona, removed: true, availability: { status: "unavailable", reason: "removed" } },
    ],
  })[0];
  expect(removed).toMatchObject({
    imported: false,
    removed: true,
    enabled: false,
    availability: "removed",
    availabilityLabel: "Removed",
    route: "Removed from this library",
  });
  expect(presentAgentPersonaCatalog({ personas: [persona] })[0]?.removed).toBe(false);
});
