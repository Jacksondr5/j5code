import { describe, expect, it } from "vite-plus/test";
import {
  AgentPersonaCreateInput,
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AgentPersonaCatalogEntry,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { PlaybookError, type PlaybookProgress } from "@t3tools/contracts/j5";
import {
  ensurePlaybookAuthor,
  playbookAuthorLaunch,
  playbookAuthorSquadrons,
  expandPlaybookPrompt,
  presentPlaybook,
  sortPlaybookRuns,
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

describe("Playbook Author Squadron ownership", () => {
  const workspace = {
    key: "remote-project",
    environmentId: EnvironmentId.make("remote"),
    projectId: ProjectId.make("shared-project-id"),
    threadId: null,
    title: "Project",
    workspaceRoot: "/remote/project",
    branch: null,
  };
  const squadron = {
    environmentId: workspace.environmentId,
    environmentLabel: "Remote",
    available: true,
    squadron: { id: "squadron:author", name: "Authoring", createdAt: "2026-09-21T00:00:00Z" },
    projectIds: [workspace.projectId],
  };
  const launch = {
    workspace,
    squadron,
    commandId: CommandId.make("create-author"),
    threadId: ThreadId.make("new-author"),
    messageId: MessageId.make("first-message"),
    createdAt: "2026-09-21T00:00:00Z",
    modelSelection: { instanceId: codex.instanceId, model: "my-model" },
  };

  it("offers only Squadrons with exactly this environment-local project", () => {
    expect(
      playbookAuthorSquadrons(workspace, [
        squadron,
        { ...squadron, environmentId: EnvironmentId.make("local") },
        { ...squadron, projectIds: [ProjectId.make("another-project")] },
        { ...squadron, projectIds: [workspace.projectId, ProjectId.make("another-project")] },
      ]),
    ).toEqual([squadron]);
  });

  it.each([
    undefined,
    { ...squadron, available: false },
    { ...squadron, environmentId: EnvironmentId.make("local") },
    { ...squadron, projectIds: [ProjectId.make("another-project")] },
  ])("blocks a missing or invalid home before a durable thread can be created", (invalid) => {
    expect(() => playbookAuthorLaunch({ ...launch, squadron: invalid })).toThrow(
      "Choose an available Squadron for this workspace",
    );
  });
});

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

it.each(["completed", "cancelled"] as const)(
  "marks the last position without an active or successful step in a %s run",
  (status) => {
    const display = presentPlaybook({ ...run, status, currentStepId: "research", position: 1 });
    expect(display.steps.map(({ state }) => state)).toEqual(["last", "later", "later"]);
    expect(display.steps.some(({ current }) => current)).toBe(false);
    expect(display.steps[0]?.label).toBe("Last position");
  },
);

it("shows available steps without guessing progress when the live definition loses the current step", () => {
  const display = presentPlaybook({ ...run, currentStepId: "removed", position: null });
  expect(display.position).toBe("Step unavailable");
  expect(display.currentTitle).toBe("removed");
  expect(display.steps.every((step) => step.state === "available" && !step.current)).toBe(true);
  expect(presentPlaybook({ ...run, steps: [], position: null, total: 0 }).steps).toEqual([]);
});

it("moves positional highlighting back without treating later steps as completed", () => {
  const display = presentPlaybook({ ...run, currentStepId: "research", position: 1 });
  expect(display.steps.map(({ state }) => state)).toEqual(["current", "later", "later"]);
});

it("retains all 100 step names and identifies the current position by stable ID", () => {
  const steps = Array.from({ length: 100 }, (_, index) => ({
    id: `step-${index + 1}`,
    title: `Step ${index + 1}`,
  }));
  const display = presentPlaybook({
    ...run,
    steps,
    total: 100,
    position: 50,
    currentStepId: "step-50",
  });
  expect(display.position).toBe("Step 50 of 100");
  expect(display.steps.map(({ id, title }) => ({ id, title }))).toEqual(steps);
  expect(display.steps.filter(({ current }) => current).map(({ id }) => id)).toEqual(["step-50"]);
  expect(display.steps[48]?.state).toBe("earlier");
  expect(display.steps[50]?.state).toBe("later");
});

it("prioritizes issues, then active runs and recency, without changing the fetched page", () => {
  const issue = new PlaybookError({
    code: "step_missing",
    message: "Step removed",
    availableStepIds: [],
  });
  const runs = Object.freeze([
    { ...run, runId: "completed", status: "completed" as const, updatedAt: "2026-09-21T14:00:00Z" },
    { ...run, runId: "older-active" },
    {
      ...run,
      runId: "cancelled-issue",
      status: "cancelled" as const,
      issue,
      updatedAt: "2026-09-21T15:00:00Z",
    },
    { ...run, runId: "active-issue", issue },
    { ...run, runId: "recent-active", updatedAt: "2026-09-21T11:00:00Z" },
    { ...run, runId: "tied-active", updatedAt: "2026-09-21T11:00:00Z" },
  ]);
  const original = [...runs];
  expect(sortPlaybookRuns(runs).map(({ runId }) => runId)).toEqual([
    "active-issue",
    "cancelled-issue",
    "recent-active",
    "tied-active",
    "older-active",
    "completed",
  ]);
  expect(runs).toEqual(original);
  expect(sortPlaybookRuns([])).toEqual([]);
});
