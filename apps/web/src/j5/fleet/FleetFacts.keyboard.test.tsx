// @vitest-environment jsdom

import type { FleetDerivedFacts } from "@t3tools/client-runtime/j5/fleetFacts";
import { EnvironmentId } from "@t3tools/contracts";
import type { FleetAgent } from "@t3tools/contracts/j5";
import userEvent from "@testing-library/user-event";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  facts: undefined as FleetDerivedFacts | undefined,
  live: true,
  asOf: "2026-10-23T12:05:00Z",
  minute: vi.fn(() => "2026-10-23T12:10"),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { read: () => unknown }) => atom.read(),
}));
vi.mock("./fleetState", () => ({
  fleetAgentFactsAtom: () => ({ read: () => state.facts }),
  fleetLiveAgentAtom: () => ({ read: () => state.live }),
  fleetReadTimeAtom: () => ({ read: () => state.asOf }),
}));
vi.mock("../../hooks/useNowMinute", () => ({ useNowMinute: state.minute }));
vi.mock("../../components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipPopup: () => null,
}));
vi.mock("../state", () => ({}));
vi.mock("./fleetClient", () => ({}));
vi.mock("../logicalProjects", () => ({}));
vi.mock("../../state/entities", () => ({}));
vi.mock("../crew/crewArchiveClient", () => ({}));
vi.mock("../crew/crewStopClient", () => ({}));
vi.mock("../playbooks/PlaybookRunsSection", () => ({}));
vi.mock("../../confirmDialog", () => ({}));
vi.mock("../../components/ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../../components/WorkspaceBreadcrumb", () => ({}));
vi.mock("../../components/WorkspacePageHeader", () => ({}));
vi.mock("../../components/ui/sidebar", () => ({}));
vi.mock("../../components/ui/scroll-area", () => ({}));
vi.mock("../../components/ui/toast", () => ({}));
vi.mock("../a2a/ArchiveWarningContent", () => ({}));
vi.mock("../../threadRoutes", () => ({}));
vi.mock("../../env", () => ({ isElectron: false }));

import { FleetRowItem } from "./FleetPage";

const environmentId = EnvironmentId.make("fleet-test");
const agent: FleetAgent = {
  participantId: "agent:test",
  threadId: "thread:test",
  displayName: "Builder",
  origin: "unknown",
  placementParentId: null,
  crew: null,
  openAsks: 1,
};
const measured: FleetDerivedFacts = {
  runtime: { state: "unknown", reason: "This environment has no readable thread shell." },
  lastActivity: { state: "unknown", reason: "Ledger activity is unavailable." },
  asks: {
    owed: [
      {
        exchangeId: "owed",
        counterpartyId: "captain",
        counterpartyName: "Captain",
        intent: "Review the patch",
        openedAt: "2026-10-23T12:00:00Z",
      },
    ],
    awaited: [
      {
        exchangeId: "awaited",
        counterpartyId: "peer",
        counterpartyName: "Reviewer",
        intent: "Send the result",
        openedAt: "2026-10-23T12:02:00Z",
      },
    ],
  },
  problems: [],
};
let root: Root;
let container: HTMLDivElement;
const navigate = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.facts = measured;
  state.live = true;
  state.minute.mockClear();
  navigate.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(rowAgent = agent) {
  await act(() =>
    root.render(
      <ul>
        <FleetRowItem
          project={{
            id: "project",
            title: "Project",
            agents: [rowAgent],
            crews: [],
            environmentId,
            environmentLabel: "Test",
          }}
          row={{ agent: rowAgent, depth: 0, crewInstanceId: null }}
          badge={null}
          threadsByKey={new Map()}
          showEnvironment={false}
          projectOf={() => undefined}
          onOpenThread={navigate}
        />
      </ul>,
    ),
  );
}
const summary = () => container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
const disclosure = () => document.getElementById(summary().getAttribute("aria-controls")!)!;
const navigation = () => container.querySelector<HTMLButtonElement>("button:not([aria-expanded])")!;

async function key(user: ReturnType<typeof userEvent.setup>, value: string) {
  await act(() => user.keyboard(value));
}

it("reveals the complete facts with Tab and Enter, closes with Space, and preserves row navigation", async () => {
  const user = userEvent.setup();
  await render();
  expect(disclosure().hidden).toBe(true);
  expect(state.minute).not.toHaveBeenCalled();
  await act(() => user.tab());
  expect(document.activeElement).toBe(navigation());
  await act(() => user.tab());
  expect(document.activeElement).toBe(summary());
  expect(summary().getAttribute("aria-label")).toBe("Facts for Builder");
  await key(user, "{Enter}");
  expect(disclosure().hidden).toBe(false);
  expect(disclosure().textContent).toContain("Captain · Review the patch · 10m ago");
  expect(disclosure().textContent).toContain("Reviewer · Send the result · 8m ago");
  expect(disclosure().textContent).toContain("This environment has no readable thread shell.");
  expect(disclosure().textContent).toContain("Ledger activity is unavailable.");
  expect(disclosure().textContent).toContain(
    "This environment has no recorded provenance for this agent.",
  );
  expect(navigate).not.toHaveBeenCalled();
  expect(navigation().querySelector("summary, button, details")).toBeNull();
  await key(user, " ");
  expect(disclosure().hidden).toBe(true);
  expect(disclosure().querySelector("div")).toBeNull();
  await act(() => user.tab({ shift: true }));
  expect(document.activeElement).toBe(navigation());
  await act(() => user.keyboard("{Enter}"));
  expect(navigate).toHaveBeenCalledExactlyOnceWith(environmentId, "thread:test");
});

it("keeps unknown reasons reachable when the agent has no thread and navigation is disabled", async () => {
  const user = userEvent.setup();
  state.facts = undefined;
  await render({ ...agent, threadId: null });
  expect(navigation().disabled).toBe(true);
  await act(() => user.tab());
  expect(document.activeElement).toBe(summary());
  await key(user, "{Enter}");
  expect(disclosure().textContent).toContain("The live Fleet read has not provided this fact.");
  expect(disclosure().textContent).toContain(
    "This environment does not provide owed and awaited Exchange details.",
  );
  expect(disclosure().textContent).toContain(
    "This environment does not provide delivery problems.",
  );
  expect(navigate).not.toHaveBeenCalled();
});

it("keeps stale ask ages frozen and names outside spawners in the disclosure", async () => {
  const user = userEvent.setup();
  state.live = false;
  await render({
    ...agent,
    outsideSpawner: { participantId: "outside", name: "External captain" },
  });
  summary().focus();
  await key(user, "{Enter}");
  expect(disclosure().textContent).toContain("this environment is unavailable");
  expect(disclosure().textContent).toContain("Captain · Review the patch · 5m at last read");
  expect(disclosure().textContent).toContain("Provenance: Spawned by External captain");
  expect(state.minute).not.toHaveBeenCalled();
});
