import { EnvironmentId } from "@t3tools/contracts";
import type * as React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SkillCatalogPanel } from "./SkillInstallerSettings";

const state = vi.hoisted(() => ({
  configuredSource: "/catalog/A",
  status: {
    data: null as unknown,
    error: null as string | null,
    isPending: true,
    refresh: vi.fn(),
  },
  persistImpl: null as null | ((value: unknown) => Promise<unknown>),
  applyCalls: [] as Array<unknown>,
  updateCalls: [] as Array<unknown>,
  applyImpl: null as null | ((value: unknown) => Promise<unknown>),
  updateImpl: null as null | ((value: unknown) => Promise<unknown>),
}));

vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "env-1",
        serverConfig: { settings: { skillCatalogSource: state.configuredSource } },
      },
    ],
  }),
  usePrimaryEnvironmentId: () => "env-1",
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => state.status,
}));

vi.mock("../../state/server", () => ({
  serverEnvironment: { updateSettings: Symbol("updateSettings") },
}));

vi.mock("./skillCatalogAtoms", () => ({
  skillCatalogEnvironment: {
    status: () => Symbol("status"),
    applyGroups: Symbol("applyGroups"),
    updateCatalog: Symbol("updateCatalog"),
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: symbol) => {
    if (typeof command === "symbol" && command.description === "updateSettings") {
      return (value: unknown) =>
        state.persistImpl ? state.persistImpl(value) : Promise.resolve({ _tag: "Success" });
    }
    if (typeof command === "symbol" && command.description === "applyGroups") {
      return (value: unknown) => {
        state.applyCalls.push(value);
        return state.applyImpl
          ? state.applyImpl(value)
          : Promise.resolve({
              _tag: "Success",
              value: {
                selectedGroups: [],
                installed: 0,
                removed: 0,
                unchanged: 0,
                conflicts: [],
                failed: [],
              },
            });
      };
    }
    return (value: unknown) => {
      state.updateCalls.push(value);
      return state.updateImpl
        ? state.updateImpl(value)
        : Promise.resolve({ _tag: "Success", value: { upstream: "origin/main" } });
    };
  },
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (result: unknown) =>
    result instanceof Error ? result : new Error("save failed"),
}));

vi.mock("../agents/AgentFolderPickerDialog", () => ({
  AgentFolderPickerDialog: () => null,
}));

vi.mock("../../components/settings/settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: React.ReactNode }) => children,
  SettingsSection: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("../../components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: {
    children?: React.ReactNode;
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("../../components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock("../../components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const environmentId = EnvironmentId.make("env-1");

function statusData(source: string) {
  return {
    catalogDir: `/state/${source === "/catalog/A" ? "a" : "b"}`,
    groups: [{ name: "core", description: "", depends: [], skills: [] }],
    selectedGroups: ["core"],
    targets: [],
    git: { upstream: "origin/main", dirty: false },
    warnings: [],
  };
}

function setStatusLoaded(source: string) {
  state.status.data = statusData(source);
  state.status.error = null;
  state.status.isPending = false;
}

async function renderPanel(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<SkillCatalogPanel environmentId={environmentId} environmentLabel="env-1" />);
  });
  return renderer!;
}

async function rerender(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => {
    renderer.update(<SkillCatalogPanel environmentId={environmentId} environmentLabel="env-1" />);
  });
}

function sourceInput(renderer: ReactTestRenderer) {
  const inputs = renderer.root.findAll(
    (node) => node.type === "input" && typeof node.props.value === "string",
  );
  return inputs[0]!;
}

function buttonByText(renderer: ReactTestRenderer, text: string) {
  const buttons = renderer.root.findAll((node) => node.type === "button");
  const found = buttons.find((button) =>
    (Array.isArray(button.props.children)
      ? button.props.children.join("")
      : String(button.props.children ?? "")
    ).includes(text),
  );
  if (!found) throw new Error(`button "${text}" not found`);
  return found;
}

function applyButton(renderer: ReactTestRenderer) {
  return buttonByText(renderer, "Apply selected groups");
}

function updateButton(renderer: ReactTestRenderer) {
  return buttonByText(renderer, "Update catalog");
}

function allParagraphText(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAll((node) => node.type === "p")
    .map((node) =>
      Array.isArray(node.props.children)
        ? node.props.children.join("")
        : String(node.props.children ?? ""),
    )
    .join("\n");
}

describe("SkillCatalogPanel source identity", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.configuredSource = "/catalog/A";
    state.status.data = null;
    state.status.error = null;
    state.status.isPending = true;
    state.status.refresh = vi.fn();
    state.persistImpl = null;
    state.applyImpl = null;
    state.updateImpl = null;
    state.applyCalls = [];
    state.updateCalls = [];
  });

  it("submits the acknowledged source after another client changes A to B", async () => {
    state.configuredSource = "/catalog/A";
    setStatusLoaded("/catalog/A");
    const renderer = await renderPanel();
    expect(sourceInput(renderer).props.value).toBe("/catalog/A");
    expect(applyButton(renderer).props.disabled).toBe(false);

    await act(async () => {
      await applyButton(renderer).props.onClick();
    });
    expect(state.applyCalls.at(-1)).toMatchObject({
      input: { expectedSource: "/catalog/A" },
    });

    // Another client saves B: the input follows acknowledged settings, but
    // actions wait for B's status instead of submitting the cached A.
    state.configuredSource = "/catalog/B";
    state.status.data = statusData("/catalog/A");
    state.status.isPending = true;
    await rerender(renderer);
    expect(sourceInput(renderer).props.value).toBe("/catalog/B");
    expect(applyButton(renderer).props.disabled).toBe(true);

    setStatusLoaded("/catalog/B");
    await rerender(renderer);
    expect(applyButton(renderer).props.disabled).toBe(false);
    await act(async () => {
      await applyButton(renderer).props.onClick();
    });
    expect(state.applyCalls.at(-1)).toMatchObject({
      input: { expectedSource: "/catalog/B" },
    });
    await act(async () => renderer.unmount());
  });

  it("discards late apply results after the catalog identity changes", async () => {
    state.configuredSource = "/catalog/A";
    setStatusLoaded("/catalog/A");
    const renderer = await renderPanel();
    expect(applyButton(renderer).props.disabled).toBe(false);

    // Start Apply on A and hold its response.
    let resolveApply!: (value: unknown) => void;
    state.applyImpl = () =>
      new Promise<unknown>((resolve) => {
        resolveApply = resolve;
      });
    applyButton(renderer).props.onClick();
    await act(async () => {});
    expect(state.applyCalls.at(-1)).toMatchObject({
      input: { expectedSource: "/catalog/A" },
    });

    // Another client switches A → B mid-operation.
    state.configuredSource = "/catalog/B";
    state.status.data = statusData("/catalog/A");
    state.status.isPending = true;
    await rerender(renderer);

    // A's late response must not appear in B's panel.
    await act(async () => {
      resolveApply({
        _tag: "Success",
        value: {
          selectedGroups: ["core"],
          installed: 7,
          removed: 0,
          unchanged: 0,
          conflicts: [],
          failed: [],
        },
      });
    });
    await act(async () => {});
    setStatusLoaded("/catalog/B");
    await rerender(renderer);

    expect(sourceInput(renderer).props.value).toBe("/catalog/B");
    expect(allParagraphText(renderer)).not.toContain("Installed 7 links");
    expect(applyButton(renderer).props.disabled).toBe(false);
    await act(async () => {
      await applyButton(renderer).props.onClick();
    });
    expect(state.applyCalls.at(-1)).toMatchObject({
      input: { expectedSource: "/catalog/B" },
    });
    await act(async () => renderer.unmount());
  });

  it("discards late update results after the catalog identity changes", async () => {
    state.configuredSource = "/catalog/A";
    setStatusLoaded("/catalog/A");
    const renderer = await renderPanel();
    expect(updateButton(renderer).props.disabled).toBe(false);

    // Start Update on A and hold its response.
    let resolveUpdate!: (value: unknown) => void;
    state.updateImpl = () =>
      new Promise<unknown>((resolve) => {
        resolveUpdate = resolve;
      });
    updateButton(renderer).props.onClick();
    await act(async () => {});
    expect(state.updateCalls.at(-1)).toMatchObject({
      input: { expectedSource: "/catalog/A" },
    });

    // Another client switches A → B mid-operation.
    state.configuredSource = "/catalog/B";
    state.status.data = statusData("/catalog/A");
    state.status.isPending = true;
    await rerender(renderer);

    // A's late response must not appear in B's panel.
    await act(async () => {
      resolveUpdate({ _tag: "Success", value: { upstream: "origin/main" } });
    });
    await act(async () => {});
    setStatusLoaded("/catalog/B");
    await rerender(renderer);

    expect(sourceInput(renderer).props.value).toBe("/catalog/B");
    expect(allParagraphText(renderer)).not.toContain("Catalog updated from");
    expect(updateButton(renderer).props.disabled).toBe(false);
    await act(async () => renderer.unmount());
  });

  it("keeps a failed save visible and actions disabled against the old source", async () => {
    state.configuredSource = "/catalog/A";
    setStatusLoaded("/catalog/A");
    const renderer = await renderPanel();
    expect(applyButton(renderer).props.disabled).toBe(false);

    await act(async () => {
      sourceInput(renderer).props.onChange({ target: { value: "/catalog/B" } });
    });
    expect(sourceInput(renderer).props.value).toBe("/catalog/B");

    state.persistImpl = () => Promise.resolve({ _tag: "Failure" });
    await act(async () => {
      await buttonByText(renderer, "Save source").props.onClick();
    });

    // The draft stays visible, Apply stays disabled (not enabled against A),
    // and the error explains the previous source is still active.
    expect(sourceInput(renderer).props.value).toBe("/catalog/B");
    expect(applyButton(renderer).props.disabled).toBe(true);
    const alerts = renderer.root.findAll((node) => node.type === "p");
    const alertText = alerts
      .map((node) =>
        Array.isArray(node.props.children)
          ? node.props.children.join("")
          : String(node.props.children ?? ""),
      )
      .join("\n");
    expect(alertText).toContain("still active");
    await act(async () => renderer.unmount());
  });
});
