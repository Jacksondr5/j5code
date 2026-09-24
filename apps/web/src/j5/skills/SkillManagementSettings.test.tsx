import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type * as React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { SkillInventoryPanel } from "./SkillManagementSettings";

const state = vi.hoisted(() => ({
  providers: [] as ReadonlyArray<ServerProvider>,
  refresh: vi.fn(),
  catalogSource: "/catalog",
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.providers }));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({
    connection: { phase: "connected" },
    serverConfig: { settings: { skillCatalogSource: state.catalogSource } },
  }),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [
    { id: "first", environmentId: "env", title: "First project", workspaceRoot: "/first" },
    { id: "second", environmentId: "env", title: "Second project", workspaceRoot: "/second" },
    {
      id: "remote",
      environmentId: "other-env",
      title: "Other environment",
      workspaceRoot: "/remote",
    },
  ],
}));
vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: { providersValueAtom: () => "providers", refreshProviders: "refresh" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => state.refresh,
}));
vi.mock("../../components/settings/settingsLayout", () => ({
  SettingsPageContainer: () => null,
  SettingsSection: () => null,
}));
vi.mock("../../components/settings/providerDriverMeta", () => ({
  getDriverOption: () => undefined,
}));
vi.mock("../../components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode;
    value: string;
    onValueChange: (value: string) => void;
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
  SelectPopup: ({ children }: { children: React.ReactNode }) => children,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));
vi.mock("../../components/ui/button", () => ({
  Button: ({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock("../../components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));
vi.mock("../../components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <code>{children}</code>,
  TooltipPopup: ({ children }: { children: React.ReactNode }) => (
    <div role="tooltip">{children}</div>
  ),
}));

const environmentId = EnvironmentId.make("env");
const instanceId = ProviderInstanceId.make("codex-work");
const checkedAt = "2026-09-18T00:00:00Z";
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  state.catalogSource = "/catalog";
  state.providers = [
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt,
      models: [],
      slashCommands: [],
      skills: [],
    },
  ];
  state.refresh
    .mockReset()
    .mockImplementation(() =>
      Promise.resolve({ _tag: "Success", value: { providers: state.providers } }),
    );
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.restoreAllMocks();
});
async function renderPanel() {
  await act(async () => {
    renderer = create(<SkillInventoryPanel environmentId={environmentId} />);
  });
  return renderer!;
}
function renderedText() {
  return JSON.stringify(renderer!.toJSON());
}
function textContent(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textContent(child)))
    .join(" ");
}
function discoveryText() {
  return textContent(renderer!.root.findByProps({ role: "status" }));
}
function inventoryText() {
  return renderer!.root.findAllByType("table").map(textContent).join(" ");
}
function refreshButton() {
  return renderer!.root
    .findAllByType("button")
    .find((button) => textContent(button) === "Refresh")!;
}
function categoryButton(origin: string) {
  return renderer!.root
    .findAllByType("button")
    .find((button) => textContent(button).trimStart().startsWith(`${origin} `))!;
}

it("shows matching skills while typing and updates rows when discovery changes", async () => {
  state.providers = [
    {
      ...state.providers[0]!,
      skills: Array.from({ length: 32 }, (_, index) => ({
        name: `review-${index}`,
        path: `/catalog/skills/review-${index}/SKILL.md`,
        enabled: true,
      })),
      workspaceSnapshots: [{ cwd: "/first", checkedAt, skills: [], slashCommands: [] }],
    },
  ];
  const panel = await renderPanel();
  await act(async () =>
    panel.root.findAllByType("select")[0]!.props.onChange({ target: { value: "" } }),
  );
  for (const value of ["r", "re", "review"])
    await act(async () => panel.root.findByType("input").props.onChange({ target: { value } }));
  expect(inventoryText()).toContain("review-31");
  state.providers = [
    {
      ...state.providers[0]!,
      skills: [{ name: "review-new", path: "/new/SKILL.md", enabled: true }],
    },
  ];
  await act(async () => panel.update(<SkillInventoryPanel environmentId={environmentId} />));
  expect(inventoryText()).toContain("review-new");
  expect(inventoryText()).not.toContain("review-31");
  await act(async () =>
    panel.root.findAllByType("select")[0]!.props.onChange({ target: { value: "first" } }),
  );
  state.catalogSource = "/new-catalog";
  await act(async () => panel.update(<SkillInventoryPanel environmentId={environmentId} />));
});

it("requests missing discovery for the first project and selection changes, with an environment-only view", async () => {
  state.providers = [
    {
      ...state.providers[0]!,
      skills: [
        {
          name: "review",
          path: "/skills/review/SKILL.md",
          linkTarget: "/shared/review/SKILL.md",
          enabled: true,
        },
        {
          name: "tools:review",
          path: "/plugins/review/SKILL.md",
          linkTarget: "/shared/review/SKILL.md",
          pluginId: "tools@team",
          enabled: false,
          userInvocationOnly: true,
        },
      ],
    },
  ];
  const panel = await renderPanel();
  const skillRow = panel.root
    .findAllByType("tr")
    .find((row) => row.findAllByType("td").length === 2)!;
  const providerCell = skillRow.findAllByType("td")[1]!;
  expect(textContent(providerCell)).toContain("review");
  expect(textContent(providerCell)).toContain("tools:review");
  expect(textContent(providerCell)).toContain("/skills/review/SKILL.md");
  expect(textContent(providerCell)).toContain("/plugins/review/SKILL.md");
  expect(textContent(providerCell)).toContain("Disabled");
  expect(textContent(providerCell)).toContain("User only");
  expect(state.refresh).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { instanceId, cwd: "/first" },
  });
  expect(discoveryText()).toContain("Not checked");
  expect(discoveryText()).not.toContain("Not detected");
  expect(renderedText()).not.toContain("Other environment");
  await act(async () =>
    panel.root.findAllByType("select")[0]!.props.onChange({ target: { value: "second" } }),
  );
  expect(state.refresh).toHaveBeenLastCalledWith({
    environmentId,
    input: { instanceId, cwd: "/second" },
  });
  await act(async () =>
    panel.root.findAllByType("select")[0]!.props.onChange({ target: { value: "" } }),
  );
  expect(state.refresh).toHaveBeenCalledTimes(2);
  expect(discoveryText()).toContain("Checked");
  await act(async () =>
    panel.root.findAllByType("select")[0]!.props.onChange({ target: { value: "first" } }),
  );
  expect(state.refresh).toHaveBeenCalledTimes(3);
  expect(state.refresh).toHaveBeenLastCalledWith({
    environmentId,
    input: { instanceId, cwd: "/first" },
  });
});

it("replaces an existing workspace on manual instance refresh, retains stale rows after failure and recovers", async () => {
  const old = { name: "old-skill", path: "/old/SKILL.md", enabled: true };
  state.providers = [
    {
      ...state.providers[0]!,
      workspaceSnapshots: [{ cwd: "/first", checkedAt, skills: [old], slashCommands: [] }],
    },
  ];
  await renderPanel();
  expect(state.refresh).not.toHaveBeenCalled();
  expect(renderedText()).toContain("old-skill");
  state.refresh.mockImplementation(() => {
    state.providers = [
      {
        ...state.providers[0]!,
        workspaceSnapshots: [
          {
            cwd: "/first",
            checkedAt,
            skills: [{ ...old, name: "new-skill", path: "/new/SKILL.md" }],
            slashCommands: [],
          },
        ],
      },
    ];
    return Promise.resolve({ _tag: "Success", value: { providers: state.providers } });
  });
  await act(async () => refreshButton().props.onClick());
  expect(state.refresh).toHaveBeenCalledExactlyOnceWith({ environmentId, input: { instanceId } });
  expect(renderedText()).toContain("new-skill");
  expect(renderedText()).not.toContain("old-skill");
  state.refresh.mockResolvedValue({ _tag: "Failure" });
  await act(async () => refreshButton().props.onClick());
  expect(renderedText()).toContain("new-skill");
  expect(discoveryText()).toContain("Refresh failed");
  expect(inventoryText()).toContain("Stale");
  state.refresh.mockImplementation(() =>
    Promise.resolve({ _tag: "Success", value: { providers: state.providers } }),
  );
  await act(async () => refreshButton().props.onClick());
  expect(discoveryText()).not.toContain("Refresh failed");
  expect(inventoryText()).not.toContain("Stale");
});

it("clears a transport failure when selecting an unchecked project succeeds later", async () => {
  state.refresh.mockResolvedValue({ _tag: "Failure" });
  const panel = await renderPanel();
  expect(discoveryText()).toContain("Refresh failed");
  await act(async () =>
    panel.root.findAllByType("select")[0]!.props.onChange({ target: { value: "" } }),
  );
  state.refresh.mockImplementation(() => {
    state.providers = [
      {
        ...state.providers[0]!,
        workspaceSnapshots: [{ cwd: "/first", checkedAt, skills: [], slashCommands: [] }],
      },
    ];
    return Promise.resolve({ _tag: "Success", value: { providers: state.providers } });
  });
  await act(async () =>
    panel.root.findAllByType("select")[0]!.props.onChange({ target: { value: "first" } }),
  );
  expect(discoveryText()).not.toContain("Refresh failed");
  expect(discoveryText()).toContain("Checked");
});

it("preserves provider-specific metadata when filtering a shared location and labels missing records", async () => {
  const first = state.providers[0]!;
  const skill = {
    name: "review",
    path: "/codex/review/SKILL.md",
    linkTarget: "/shared/review/SKILL.md",
    enabled: true,
  };
  const otherSkill = { name: "deploy", path: "/deploy/SKILL.md", enabled: true };
  const secondId = ProviderInstanceId.make("codex-personal");
  state.providers = [
    {
      ...first,
      workspaceSnapshots: [{ cwd: "/first", checkedAt, slashCommands: [], skills: [skill] }],
    },
    {
      ...first,
      instanceId: secondId,
      workspaceSnapshots: [
        {
          cwd: "/first",
          checkedAt,
          slashCommands: [],
          skills: [
            {
              ...skill,
              name: "audit",
              path: "/personal/audit/SKILL.md",
              pluginId: "audit@team",
              userInvocable: false,
            },
          ],
        },
      ],
    },
    {
      ...first,
      instanceId: ProviderInstanceId.make("empty"),
      workspaceSnapshots: [{ cwd: "/first", checkedAt, slashCommands: [], skills: [otherSkill] }],
    },
    {
      ...first,
      instanceId: ProviderInstanceId.make("unchecked"),
      enabled: false,
      skills: [otherSkill],
    },
    {
      ...first,
      instanceId: ProviderInstanceId.make("failed"),
      status: "error",
      workspaceSnapshots: [
        {
          cwd: "/first",
          checkedAt,
          slashCommands: [],
          skills: [otherSkill],
          refreshError: "Failed",
        },
      ],
    },
  ];
  const panel = await renderPanel();
  for (const header of panel.root.findAllByType("thead")) {
    expect(textContent(header)).toContain("codex (codex-work)");
  }
  const row = panel.root
    .findAllByType("tr")
    .find(
      (entry) => entry.findAllByType("td").length === 6 && textContent(entry).includes("review"),
    )!;
  const cells = row.findAllByType("td");
  expect(textContent(cells[3]!)).toContain("Not detected");
  expect(textContent(cells[4]!)).toContain("Not checked");
  expect(textContent(cells[5]!)).toContain("Refresh failed");
  expect(textContent(row)).not.toContain("Stale");
  await act(async () =>
    panel.root.findAllByType("select")[1]!.props.onChange({ target: { value: secondId } }),
  );
  const selectedRow = panel.root
    .findAllByType("tr")
    .find((entry) => entry.findAllByType("td").length === 2)!;
  expect(textContent(selectedRow)).toContain("audit");
  expect(textContent(selectedRow)).toContain("audit@team");
  expect(textContent(selectedRow)).toContain("Agent only");
  expect(textContent(selectedRow)).not.toContain("/codex/review/SKILL.md");
  expect(textContent(panel.root.findByType("thead"))).not.toContain("codex-personal");
});

it("hides empty providers in the current scope, retains cached skills, and keeps empty supported providers selectable and refreshable", async () => {
  const first = state.providers[0]!;
  const claudeId = ProviderInstanceId.make("claudeAgent");
  const skill = { name: "review", path: "/review/SKILL.md", enabled: true };
  state.providers = [
    {
      ...first,
      displayName: "Codex",
      workspaceSnapshots: [{ cwd: "/first", checkedAt, slashCommands: [], skills: [skill] }],
    },
    {
      ...first,
      instanceId: claudeId,
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "Claude",
      skills: [skill],
      workspaceSnapshots: [{ cwd: "/first", checkedAt, slashCommands: [], skills: [] }],
    },
    {
      ...first,
      instanceId: ProviderInstanceId.make("antigravity"),
      driver: ProviderDriverKind.make("antigravity"),
      displayName: "Antigravity",
      enabled: false,
    },
    {
      ...first,
      instanceId: ProviderInstanceId.make("opencode"),
      driver: ProviderDriverKind.make("opencode"),
      displayName: "OpenCode",
      enabled: false,
      skills: [{ ...skill, name: "deploy", path: "/deploy/SKILL.md" }],
    },
  ];
  const panel = await renderPanel();
  const headers = () =>
    panel.root.findAllByType("thead").map((header) => header.findAllByType("th").map(textContent));
  expect(headers()).toEqual([["Skill", "Codex Codex", "OpenCode OpenCode"]]);
  expect(discoveryText()).not.toContain("Claude");
  expect(discoveryText()).not.toContain("Antigravity");
  expect(inventoryText()).toContain("Stale");
  expect(textContent(panel.root.findAllByType("select")[1]!)).toContain("Claude");
  await act(async () =>
    panel.root.findByType("input").props.onChange({ target: { value: "review" } }),
  );
  expect(headers()).toEqual([["Skill", "Codex Codex", "OpenCode OpenCode"]]);
  await act(async () =>
    panel.root.findAllByType("select")[1]!.props.onChange({ target: { value: claudeId } }),
  );
  expect(panel.root.findAllByType("table")).toHaveLength(0);
  expect(discoveryText()).toContain("Claude");
  expect(discoveryText()).toContain("Checked");
  expect(renderedText()).toContain("No skills reported for this selection");
  await act(async () =>
    panel.root.findAllByType("select")[1]!.props.onChange({ target: { value: "" } }),
  );
  await act(async () => refreshButton().props.onClick());
  expect(state.refresh).toHaveBeenCalledWith({ environmentId, input: { instanceId: claudeId } });
  await act(async () =>
    panel.root.findAllByType("select")[0]!.props.onChange({ target: { value: "" } }),
  );
  expect(headers()).toEqual([["Skill", "Claude Claude", "OpenCode OpenCode"]]);
});

it("groups skills in origin order, collapses categories independently, and reveals search matches", async () => {
  const skills = [
    { name: "review", path: "/plugins/review/SKILL.md", pluginId: "tools" },
    { name: "build", path: "/plugins/build/SKILL.md", pluginId: "tools" },
    { name: "catalog-skill", path: "/catalog/skills/catalog-skill/SKILL.md" },
    { name: "project-skill", path: "/first/skills/project-skill/SKILL.md" },
    { name: "personal-skill", path: "/skills/personal-skill/SKILL.md", scope: "user" },
    { name: "builtin-skill", path: "/skills/builtin-skill/SKILL.md", scope: "system" },
    { name: "other-skill", path: "/skills/other-skill/SKILL.md" },
  ].map((skill) => ({ ...skill, enabled: true }));
  state.providers = [
    {
      ...state.providers[0]!,
      workspaceSnapshots: [{ cwd: "/first", checkedAt, skills, slashCommands: [] }],
    },
  ];
  const panel = await renderPanel();
  const tableNames = () =>
    panel.root.findAllByType("table").map((table) => table.props["aria-label"]);
  expect(tableNames()).toEqual([
    "Plugin skill inventory",
    "Catalog skill inventory",
    "Project skill inventory",
    "Personal skill inventory",
    "Built-in skill inventory",
    "Other skill inventory",
  ]);
  expect(textContent(categoryButton("Plugin"))).toContain("2");
  for (const header of panel.root.findAllByType("thead")) {
    expect(header.findAllByType("th").map(textContent)).toEqual(["Skill", "codex codex"]);
  }

  await act(async () => categoryButton("Plugin").props.onClick({}));
  // The node renderer has no DOM for Base UI to finish panel transitions.
  // Observe expanded state for toggles, and rendered contents for filtering.
  expect(categoryButton("Plugin").props["aria-expanded"]).toBe(false);
  expect(categoryButton("Catalog").props["aria-expanded"]).toBe(true);
  await act(async () => categoryButton("Catalog").props.onClick({}));
  expect(categoryButton("Catalog").props["aria-expanded"]).toBe(false);
  await act(async () => categoryButton("Plugin").props.onClick({}));
  expect(categoryButton("Plugin").props["aria-expanded"]).toBe(true);
  expect(inventoryText()).toContain("review");
  expect(categoryButton("Catalog").props["aria-expanded"]).toBe(false);
  await act(async () => categoryButton("Plugin").props.onClick({}));

  await act(async () =>
    panel.root.findByType("input").props.onChange({ target: { value: "review" } }),
  );
  expect(tableNames()).toEqual(["Plugin skill inventory"]);
  expect(textContent(categoryButton("Plugin"))).toContain("1");
  expect(categoryButton("Plugin").props["aria-expanded"]).toBe(true);
  expect(inventoryText()).toContain("review");
  expect(inventoryText()).not.toContain("build");
  expect(categoryButton("Catalog")).toBeUndefined();
  await act(async () => categoryButton("Plugin").props.onClick({}));
  expect(categoryButton("Plugin").props["aria-expanded"]).toBe(false);
  await act(async () =>
    panel.root.findByType("input").props.onChange({ target: { value: "no matching skill" } }),
  );
  expect(categoryButton("Plugin")).toBeUndefined();
  expect(renderedText()).toContain("No skills reported for this selection");
});

it("keeps collapsed categories across filters and refresh, and resets them on remount", async () => {
  const first = state.providers[0]!;
  const otherId = ProviderInstanceId.make("other");
  const skill = { name: "review", path: "/review/SKILL.md", pluginId: "tools", enabled: true };
  state.providers = [
    { ...first, skills: [skill] },
    { ...first, instanceId: otherId },
  ];
  const panel = await renderPanel();
  await act(async () => categoryButton("Plugin").props.onClick({}));
  await act(async () =>
    panel.root.findAllByType("select")[1]!.props.onChange({ target: { value: otherId } }),
  );
  expect(categoryButton("Plugin")).toBeUndefined();
  await act(async () =>
    panel.root.findAllByType("select")[1]!.props.onChange({ target: { value: instanceId } }),
  );
  expect(categoryButton("Plugin").props["aria-expanded"]).toBe(false);
  await act(async () =>
    panel.root.findAllByType("select")[0]!.props.onChange({ target: { value: "" } }),
  );
  await act(async () => refreshButton().props.onClick());
  expect(categoryButton("Plugin").props["aria-expanded"]).toBe(false);
  expect(inventoryText()).not.toContain("review");

  await act(async () => {
    panel.update(<SkillInventoryPanel key="remounted" environmentId={environmentId} />);
  });
  expect(categoryButton("Plugin").props["aria-expanded"]).toBe(true);
  expect(inventoryText()).toContain("review");
});
