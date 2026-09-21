import { describe, expect, it } from "vite-plus/test";
import {
  AgentPersonaCreateInput,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AgentPersonaCatalogEntry,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { PlaybookProgress } from "@t3tools/contracts/j5";
import {
  ensurePlaybookAuthor,
  expandPlaybookPrompt,
  presentPlaybook,
  playbookWorkspaces,
} from "./playbooks.ts";

const author: OrchestrationV2AgentPersonaCatalogEntry = {
  personaId: "playbook-author",
  displayName: "My customized author",
  description: "Keep my edits",
  definitionVersion: 1,
  defaultAuthorityPolicy: "workspace-write",
  allowedAuthorityPolicies: ["workspace-write"],
  availability: {
    status: "available",
    resolvedRoute: "primary",
    resolvedDriver: ProviderDriverKind.make("codex"),
    resolvedModelSelection: {
      instanceId: ProviderInstanceId.make("remote-codex"),
      model: "my-model",
    },
  },
};
const codex: ServerProvider = {
  instanceId: ProviderInstanceId.make("remote-codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-21T00:00:00Z",
  availability: "available",
  slashCommands: [],
  skills: [],
  models: [
    {
      slug: "my-model",
      name: "My model",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [{ id: "high", label: "High" }],
          },
        ],
      },
    },
  ],
};
const decodePersonaCreate = Schema.decodeUnknownSync(AgentPersonaCreateInput);

describe("Playbook Author installation", () => {
  it("creates a valid editable author once and uses the server-resolved provider instance", async () => {
    let installed: OrchestrationV2AgentPersonaCatalogEntry | undefined;
    const definitions: AgentPersonaCreateInput[] = [];
    const input = {
      providers: [codex],
      readCatalog: async () => ({ personas: installed ? [installed] : [] }),
      createPersona: async (definition: AgentPersonaCreateInput) => {
        definitions.push(decodePersonaCreate(definition));
        installed = author;
      },
    };
    expect(await ensurePlaybookAuthor(input)).toEqual({
      instanceId: "remote-codex",
      model: "my-model",
    });
    await ensurePlaybookAuthor(input);
    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toMatchObject({
      id: "playbook-author",
      authorityPolicy: "workspace-write",
      modelRoute: [
        { driver: "codex", model: "my-model", reasoningEffort: "high" },
        { driver: "codex", model: "my-model", reasoningEffort: "high" },
      ],
    });
  });

  it("reuses customized authors without rewriting or needing local provider data", async () => {
    expect(
      await ensurePlaybookAuthor({
        providers: [],
        readCatalog: async () => ({ personas: [author] }),
        createPersona: async () => {
          throw new Error("must not overwrite");
        },
      }),
    ).toEqual({ instanceId: "remote-codex", model: "my-model" });
  });

  it.each(["disabled", "removed", "routes-unavailable", "authority-not-enforceable"] as const)(
    "respects an existing author's %s state",
    async (reason) => {
      await expect(
        ensurePlaybookAuthor({
          providers: [codex],
          readCatalog: async () => ({
            personas: [
              {
                ...author,
                availability: { status: "unavailable", reason },
              },
            ],
          }),
          createPersona: async () => {
            throw new Error("must not replace");
          },
        }),
      ).rejects.toThrow("Settings → Agents");
    },
  );

  it("requires write authority without silently changing a customized author", async () => {
    await expect(
      ensurePlaybookAuthor({
        providers: [codex],
        readCatalog: async () => ({
          personas: [{ ...author, defaultAuthorityPolicy: "read-only" }],
        }),
        createPersona: async () => {
          throw new Error("must not overwrite");
        },
      }),
    ).rejects.toThrow("Workspace write authority");
  });

  it("does not create an unusable author when only Claude is configured", async () => {
    await expect(
      ensurePlaybookAuthor({
        providers: [{ ...codex, driver: ProviderDriverKind.make("claudeAgent") }],
        readCatalog: async () => ({ personas: [] }),
        createPersona: async () => {
          throw new Error("must not create");
        },
      }),
    ).rejects.toThrow("authenticated Codex provider");
  });

  it("uses an author created concurrently by another client", async () => {
    let installed = false;
    expect(
      await ensurePlaybookAuthor({
        providers: [codex],
        readCatalog: async () => ({ personas: installed ? [author] : [] }),
        createPersona: async () => {
          installed = true;
          throw new Error("ID already exists");
        },
      }),
    ).toEqual({ instanceId: "remote-codex", model: "my-model" });
  });

  it("surfaces a failed write when no author was installed", async () => {
    await expect(
      ensurePlaybookAuthor({
        providers: [codex],
        readCatalog: async () => ({ personas: [] }),
        createPersona: async () => {
          throw new Error("Read-only connection");
        },
      }),
    ).rejects.toThrow("Read-only connection");
  });
});

it("keeps project and worktree libraries scoped when two environments share IDs", () => {
  const projects = ["alpha", "bravo"].map((name) => ({
    environmentId: EnvironmentId.make(name),
    id: ProjectId.make("same-project"),
    title: "Project",
    workspaceRoot: `/${name}/main`,
  }));
  const threads = projects.map((project) => ({
    environmentId: project.environmentId,
    projectId: project.id,
    id: ThreadId.make("same-thread"),
    title: "Task",
    worktreePath: `/${project.environmentId}/feature`,
    branch: "feature",
    deletedAt: null,
  }));
  const workspaces = playbookWorkspaces(projects, [
    ...threads,
    { ...threads[0]!, id: ThreadId.make("deleted"), deletedAt: "2026-09-21T00:00:00Z" },
    { ...threads[0]!, id: ThreadId.make("root"), worktreePath: projects[0]!.workspaceRoot },
    { ...threads[0]!, id: ThreadId.make("unattached"), worktreePath: null },
  ]);
  expect(new Set(workspaces.map(({ key }) => key)).size).toBe(4);
  expect(
    workspaces.map(({ environmentId, threadId, workspaceRoot }) => ({
      environmentId,
      threadId,
      workspaceRoot,
    })),
  ).toEqual([
    { environmentId: "alpha", threadId: null, workspaceRoot: "/alpha/main" },
    { environmentId: "alpha", threadId: "same-thread", workspaceRoot: "/alpha/feature" },
    { environmentId: "bravo", threadId: null, workspaceRoot: "/bravo/main" },
    { environmentId: "bravo", threadId: "same-thread", workspaceRoot: "/bravo/feature" },
  ]);
});

describe("playbook composer expansion", () => {
  it.each([
    ["/playbook release", "Start playbook release"],
    ["  /playbook release.yaml  ", "Start playbook release.yaml"],
    ["/playbook", "List available playbooks and help me choose one to start."],
    ["Explain /playbook release", "Explain /playbook release"],
    ["/playbook release\nDo something else", "/playbook release\nDo something else"],
    ["/playbooks release", "/playbooks release"],
    ["/plan", "/plan"],
    ["", ""],
  ])("expands only a standalone playbook request: %s", (text, expected) => {
    expect(expandPlaybookPrompt(text)).toBe(expected);
  });
});

const run: PlaybookProgress = {
  runId: "run-a",
  ownerThreadId: ThreadId.make("thread-a"),
  definitionPath: "/workspace/.j5/playbooks/demo.yaml",
  currentStepId: "build",
  status: "active",
  createdAt: "2026-09-21T10:00:00Z",
  updatedAt: "2026-09-21T10:00:00Z",
  title: "Demo",
  description: "Do the work",
  steps: [
    { id: "research", title: "Research" },
    { id: "build", title: "Build" },
    { id: "review", title: "Review" },
  ],
  position: 2,
  total: 3,
  issue: null,
};
it("presents the current phase without inventing success for earlier steps", () => {
  const display = presentPlaybook(run);
  expect(display.position).toBe("Step 2 of 3");
  expect(display.currentTitle).toBe("Build");
  expect(display.steps.map(({ label }) => label)).toEqual(["Earlier", "Current", "Later"]);
  expect(presentPlaybook({ ...run, status: "cancelled" })).toMatchObject({
    status: "Cancelled",
    steps: [{ label: "Earlier" }, { label: "Last position" }, { label: "Later" }],
  });
});
it("preserves the phase identity when live steps are reordered", () => {
  const display = presentPlaybook({
    ...run,
    steps: [run.steps[1]!, run.steps[2]!, run.steps[0]!],
    position: 1,
  });
  expect(display.currentTitle).toBe("Build");
  expect(display.steps.map(({ current }) => current)).toEqual([true, false, false]);
});
