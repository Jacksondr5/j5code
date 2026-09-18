import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  connected: false,
  listArtifacts: vi.fn(),
  readArtifact: vi.fn(),
}));

vi.mock("../../state/entities", () => ({
  useProjects: () => [
    {
      id: "project:artifacts-connection",
      environmentId: "environment:artifacts-connection",
      title: "Artifacts test",
      workspaceRoot: "/workspace",
    },
  ],
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      { environmentId: "environment:artifacts-connection", label: "Test environment" },
    ],
  }),
}));
vi.mock("../../state/session", () => ({
  usePreparedConnection: () =>
    testState.connected ? { _tag: "Some", value: {} } : { _tag: "None" },
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: undefined }) }));
vi.mock("../../hooks/useResizableWidth", () => ({
  useResizableWidth: () => ({ width: 176, handlers: {} }),
}));
vi.mock("./artifactChanges", () => ({
  artifactEnvironment: { changes: () => Symbol("artifact-changes") },
}));
vi.mock("./artifactClient", () => ({
  listArtifacts: testState.listArtifacts,
  readArtifact: testState.readArtifact,
  trashArtifact: vi.fn(),
}));
vi.mock("../../components/ChatMarkdown", () => ({ default: () => null }));
vi.mock("../../components/DiffFilePathCopyButton", () => ({
  DiffFilePathCopyButton: () => null,
}));
vi.mock("../../components/ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../../components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));
vi.mock("../../components/ui/sidebar", () => ({
  SidebarInset: ({ children }: React.PropsWithChildren) => <main>{children}</main>,
}));
vi.mock("../../components/ui/tooltip", () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipPopup: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children, render }: React.PropsWithChildren<{ render?: React.ReactNode }>) => (
    <>{render ?? children}</>
  ),
}));
vi.mock("../../components/WorkspaceBreadcrumb", () => ({
  WorkspaceBreadcrumb: ({ children }: React.PropsWithChildren) => <>{children}</>,
  WorkspaceBreadcrumbItem: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../workspaceTitlebar", () => ({ COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS: "" }));

import { ArtifactsPage } from "./ArtifactsPage";

const renderPage = () => (
  <ArtifactsPage
    embedded
    initialEnvironmentId="environment:artifacts-connection"
    initialProjectId="project:artifacts-connection"
  />
);

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testState.connected = false;
  testState.listArtifacts.mockReset().mockResolvedValue([]);
  testState.readArtifact.mockReset();
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("ArtifactsPage environment connection", () => {
  it("waits for usePreparedConnection before listing artifacts", async () => {
    await act(async () => {
      renderer = create(renderPage());
    });
    expect(testState.listArtifacts).not.toHaveBeenCalled();

    testState.connected = true;
    await act(async () => {
      renderer?.update(renderPage());
    });

    expect(testState.listArtifacts).toHaveBeenCalledExactlyOnceWith({
      environmentId: "environment:artifacts-connection",
      projectId: "project:artifacts-connection",
    });
  });
});
