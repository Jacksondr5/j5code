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
  version: 0,
  listeners: new Set<() => void>(),
  timestampFormat: "24-hour" as "12-hour" | "24-hour",
  asOf: "2026-10-23T12:05:00Z",
}));
vi.mock("@effect/atom-react", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useAtomValue: (atom: { read: () => unknown }) => {
      useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => state.version,
      );
      return atom.read();
    },
  };
});
vi.mock("../../hooks/useSettings", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useClientSettings: (
      select: (settings: { timestampFormat: typeof state.timestampFormat }) => unknown,
    ) => {
      useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => state.version,
      );
      return select({ timestampFormat: state.timestampFormat });
    },
  };
});
vi.mock("./fleetState", () => ({
  fleetAgentFactsAtom: () => ({ read: () => state.facts }),
  fleetLiveAgentAtom: () => ({ read: () => state.live }),
  fleetReadTimeAtom: () => ({ read: () => state.asOf }),
  fleetEnvironmentLivenessAtom: { read: () => new Map([["fleet-test", state.live]]) },
}));
vi.mock("../../components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipPopup: () => null,
}));
vi.mock("../state", () => ({
  fleetSourcesAtom: {
    read: () => ({
      sources: [
        { environmentId: "fleet-test", environmentLabel: "Test", data: { asOf: state.asOf } },
      ],
    }),
  },
}));
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
import { FleetSourceReadout } from "./FleetFacts";

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
  state.timestampFormat = "24-hour";
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-23T12:10:00Z"));
  navigate.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render(rowAgent = agent) {
  await act(() =>
    root.render(
      <>
        <FleetSourceReadout />
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
        </ul>
      </>,
    ),
  );
}
async function refreshState() {
  await act(() => {
    state.version++;
    for (const listener of state.listeners) listener();
  });
}
const summary = () => container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
const disclosure = () => document.getElementById(summary().getAttribute("aria-controls")!)!;
const navigation = () => container.querySelector<HTMLButtonElement>("button:not([aria-expanded])")!;

async function key(user: ReturnType<typeof userEvent.setup>, value: string) {
  await act(() => user.keyboard(value));
}

it("reveals the complete facts with Tab and Enter, closes with Space, and preserves row navigation", async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  await render();
  expect(disclosure().hidden).toBe(true);
  await act(() => user.tab());
  expect(document.activeElement).toBe(navigation());
  await act(() => user.tab());
  expect(document.activeElement).toBe(summary());
  expect(summary().getAttribute("aria-label")).toBe("Facts for Builder");
  await key(user, "{Enter}");
  expect(disclosure().hidden).toBe(false);
  expect(disclosure().textContent).toContain("Captain · Review the patch · opened 10m");
  expect(disclosure().textContent).toContain("Reviewer · Send the result · opened 8m");
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
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
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
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
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
});

const timedFacts: FleetDerivedFacts = {
  ...measured,
  runtime: { state: "known", status: "idle", settled: false, since: "2026-10-23T12:00:00Z" },
  lastActivity: { state: "known", at: "2026-10-23T12:03:00Z", label: "Last turn ended" },
  problems: [
    {
      kind: "delivery-failed",
      messageId: "failed",
      receiverId: "peer",
      receiverName: "Reviewer",
      at: "2026-10-23T12:08:00Z",
      reason: "offline",
      exchangeOpen: true,
    },
  ],
};

it("refreshes live row, expanded facts, asks and environment times on the shared minute tick", async () => {
  state.facts = timedFacts;
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  await render();
  summary().focus();
  await key(user, "{Enter}");
  expect(navigation().textContent).toContain("Idle since 10m");
  expect(navigation().textContent).toContain("Last turn ended 7m");
  expect(navigation().textContent).toContain("Delivery failed · to Reviewer · 2m · offline");
  expect(disclosure().textContent).toContain("opened 10m");
  expect(container.querySelector("p")?.textContent).toContain("ledger as of 5m");

  await act(() => vi.advanceTimersByTime(60_000));

  expect(navigation().textContent).toContain("Idle since 11m");
  expect(navigation().textContent).toContain("Last turn ended 8m");
  expect(navigation().textContent).toContain("Delivery failed · to Reviewer · 3m · offline");
  expect(disclosure().textContent).toContain("Status: Idle since 11m");
  expect(disclosure().textContent).toContain("Last activity: Last turn ended 8m");
  expect(disclosure().textContent).toContain("Delivery failed · to Reviewer · 3m · offline");
  expect(disclosure().textContent).toContain("opened 11m");
  expect(container.querySelector("p")?.textContent).toContain("ledger as of 6m");
  expect(disclosure().textContent).toContain("12:00, 23rd October 2026");
  expect(disclosure().textContent).toContain("12:03, 23rd October 2026");
  expect(disclosure().textContent).toContain("12:08, 23rd October 2026");

  state.timestampFormat = "12-hour";
  await refreshState();
  expect(disclosure().textContent).toContain("12:00 PM, 23rd October 2026");
  expect(disclosure().textContent).toContain("12:03 PM, 23rd October 2026");
  expect(disclosure().textContent).toContain("12:08 PM, 23rd October 2026");
});

it("stops aging every measurement when a live row freezes, then resumes from the current clock", async () => {
  state.facts = timedFacts;
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  await render();
  summary().focus();
  await key(user, "{Enter}");
  expect(navigation().textContent).toContain("Idle since 10m");

  state.live = false;
  await refreshState();
  const frozen = container.textContent;
  expect(vi.getTimerCount()).toBe(0);
  expect(frozen).toContain("23rd October 2026");
  expect(disclosure().textContent).toContain("5m at last read · opened");
  expect(navigation().textContent).not.toContain("Idle since 10m");
  expect(navigation().textContent).not.toContain("Last turn ended 7m");
  expect(navigation().textContent).not.toContain("Reviewer · 2m");
  expect(container.querySelector("p")?.textContent).toContain("stale");

  await act(() => vi.advanceTimersByTime(3 * 86_400_000));
  expect(container.textContent).toBe(frozen);

  state.live = true;
  await refreshState();
  expect(navigation().textContent).toContain("Idle since 3d");
  expect(navigation().textContent).toContain("Last turn ended 3d");
  expect(disclosure().textContent).toContain("opened 3d");
  expect(container.querySelector("p")?.textContent).toContain("ledger as of 3d");
});

it("advances waiting-to-start ages and freezes their absolute request time", async () => {
  state.facts = {
    ...measured,
    runtime: {
      state: "known",
      status: "waiting-to-start",
      settled: false,
      since: "2026-10-23T12:00:00Z",
    },
    problems: [{ kind: "dispatch-overdue", runId: "requested", at: "2026-10-23T12:00:00Z" }],
  };
  await render();
  expect(navigation().textContent).toContain("Waiting to start · 10m");
  expect(navigation().textContent).toContain("Run not dispatched · requested 10m");
  await act(() => vi.advanceTimersByTime(60_000));
  expect(navigation().textContent).toContain("Waiting to start · 11m");
  expect(navigation().textContent).toContain("Run not dispatched · requested 11m");

  state.live = false;
  await refreshState();
  expect(navigation().textContent).toContain("Waiting to start · since 12:00, 23rd October 2026");
  expect(navigation().textContent).toContain(
    "Run not dispatched · requested 12:00, 23rd October 2026",
  );
  const frozen = navigation().textContent;
  await act(() => vi.advanceTimersByTime(60_000));
  expect(navigation().textContent).toBe(frozen);
});
