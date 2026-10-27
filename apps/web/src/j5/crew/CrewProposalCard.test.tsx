// @vitest-environment jsdom

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type {
  CrewProposal,
  CrewProposalPreviewRequest,
  CrewProposalPreviewResponse,
} from "@t3tools/contracts/j5";
import { act, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ permitted: true, preview: vi.fn() }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: (atom: unknown) => atom }));
vi.mock("../state", () => ({
  j5Environment: { resolveCrewProposal: { permissionAtom: () => state.permitted } },
}));
vi.mock("../a2a/ParticipantIdentitiesClient", () => ({
  useParticipantLabels: () => new Map([["captain", "Release Captain"]]),
}));
vi.mock("../sharing/access", () => ({ useCanOperateThread: () => state.permitted }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: {} }) }));
vi.mock("@t3tools/client-runtime/j5/agent-personas", () => ({
  presentAgentPersonaCatalog: () => [
    { personaId: "sentry", displayName: "Sentry", availability: "available" },
    { personaId: "critic", displayName: "Critic", availability: "available" },
  ],
}));
vi.mock("../agents/agentPersonaAtoms", () => ({
  agentPersonaEnvironment: { catalog: () => null },
}));
vi.mock("./crewProposalsClient", () => ({
  previewCrewProposal: (...args: unknown[]) => state.preview(...args),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { providersValueAtom: () => providers },
}));
vi.mock("../../components/WorktreeBaseBranchPicker", () => ({
  WorktreeBaseBranchPicker: () => null,
}));
vi.mock("../../components/chat/ProviderModelPicker", () => ({
  ProviderModelPicker: (props: {
    onOpenChange: (open: boolean) => void;
    onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
  }) => {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            props.onOpenChange(true);
          }}
        >
          Pick model
        </button>
        {open
          ? createPortal(
              <button
                type="button"
                data-testid="portalled-model"
                onClick={() => {
                  props.onInstanceModelChange(ProviderInstanceId.make("codex"), "other-model");
                  props.onOpenChange(false);
                  setOpen(false);
                }}
              >
                Other model
              </button>,
              document.body,
            )
          : null}
      </>
    );
  },
}));

import { CrewProposalCard } from "./CrewProposalCard";

const providers: ReadonlyArray<ServerProvider> = [
  {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-27T00:00:00Z",
    slashCommands: [],
    skills: [],
    models: [
      { slug: "gpt-6", name: "GPT-6", isCustom: false, capabilities: null },
      { slug: "other-model", name: "Other model", isCustom: false, capabilities: null },
    ],
  },
];
const proposal: CrewProposal = {
  id: "proposal:1",
  projectId: "project:1",
  captainParticipantId: "captain",
  captainThreadId: "captain-thread",
  crewInstanceId: null,
  kind: "roster",
  status: "open",
  displayName: "Ship a fix",
  brief: "Implement and review the fix.",
  requestedSeats: [
    { seat: "builder", agentId: null, instructions: "Implement", reason: "Build the fix" },
    { seat: "reviewer", agentId: "sentry", reason: "Review independently" },
  ],
  approvedSeats: null,
  createdAt: "2026-10-27T00:00:00Z",
  resolvedAt: null,
};
const preview = (
  _environment: EnvironmentId,
  input: CrewProposalPreviewRequest,
): Promise<CrewProposalPreviewResponse> =>
  Promise.resolve({
    proposalId: input.proposalId,
    workspaceOptions: { cwd: "/repo", currentBranch: "main", worktrees: [] },
    approvalToken: "token:" + JSON.stringify(input.seats),
    seats: (input.seats ?? proposal.requestedSeats).map((seat) => ({
      seat: seat.seat,
      provider: "OpenAI",
      harness: "Codex",
      model: seat.modelSelection?.model ?? "GPT-6",
      reasoning: "High",
      access: seat.runtimeMode === "approval-required" ? "Supervised" : "Full access",
      runtimeMode: seat.runtimeMode ?? "full-access",
      modelSelection: seat.modelSelection ?? {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-6",
      },
      workspace: seat.workspace ?? { type: "shared" },
    })),
  });
let container: HTMLDivElement;
let root: Root;
const resolve = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  state.permitted = true;
  state.preview.mockReset().mockImplementation(preview);
  resolve.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render(overrides: Partial<React.ComponentProps<typeof CrewProposalCard>> = {}) {
  await act(async () =>
    root.render(
      <ul>
        <CrewProposalCard
          proposal={proposal}
          environmentId={EnvironmentId.make("test")}
          busy={false}
          onResolve={resolve}
          {...overrides}
        />
      </ul>,
    ),
  );
}
const button = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.getAttribute("aria-label") === label || item.textContent === label,
  )!;
const option = (trigger: string, text: string) => {
  const popup = document.getElementById(button(trigger).getAttribute("aria-controls")!)!;
  return [...popup.querySelectorAll<HTMLElement>('[role="option"]')].find((item) =>
    item.textContent?.startsWith(text),
  )!;
};
const approve = () =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    item.textContent?.startsWith("Approve "),
  )!;
async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    element.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
    element.click();
  });
}
async function input(label: string, value: string) {
  const element = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`,
  )!;
  await act(async () => {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("applies edits immediately, retains them across rows, and approves only after closing", async () => {
  await render();
  expect(approve().disabled).toBe(false);
  await click(button("Edit seat builder"));
  expect(approve().disabled).toBe(true);
  await input("builder instructions", "Implement carefully");
  expect(container.textContent).toContain("Edited");
  await click(button("Edit seat reviewer"));
  expect(container.querySelector('[aria-label="builder instructions"]')).toBeNull();
  await click(button("Done"));
  expect(state.preview).toHaveBeenLastCalledWith(
    "test",
    expect.objectContaining({
      seats: [
        expect.objectContaining({ instructions: "Implement carefully" }),
        proposal.requestedSeats[1],
      ],
    }),
  );
  expect(approve().disabled).toBe(false);
  await click(approve());
  expect(resolve).toHaveBeenCalledWith(
    "approve",
    [
      expect.objectContaining({ instructions: "Implement carefully", reason: "Build the fix" }),
      proposal.requestedSeats[1],
    ],
    expect.stringContaining("token:"),
  );
});

it("retains invalid instructions on outside click and clears Edited after restoration", async () => {
  await render();
  await click(button("Edit seat builder"));
  await input("builder instructions", "");
  await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  expect(button("Done")).toBeUndefined();
  expect(container.textContent).toContain("Give the custom crew member its instructions");
  expect(approve().disabled).toBe(true);
  await click(button("Edit seat builder"));
  await input("builder instructions", "Implement");
  expect(container.textContent).not.toContain("Edited");
  await click(button("Done"));
  expect(approve().disabled).toBe(false);
});

it("focuses a custom addition, blocks approval until complete, and can remove it", async () => {
  await render();
  await click(button("Add crew member"));
  expect(document.activeElement?.getAttribute("aria-label")).toBe("New seat name");
  expect(container.querySelector('[aria-label="New seat instructions"]')).not.toBeNull();
  expect(approve().textContent).toBe("Approve 3 members");
  await input("New seat name", "tester");
  await click(button("Done"));
  expect(approve().disabled).toBe(true);
  await click(button("Edit seat tester"));
  await input("tester instructions", "Test the change");
  await click(button("Done"));
  expect(approve().disabled).toBe(false);
  await click(button("Remove seat tester"));
  expect(approve().textContent).toBe("Approve 2 members");
  await click(button("Remove seat reviewer"));
  expect(button("Remove seat builder").disabled).toBe(true);
});

it("keeps a row open when picking through a portal and closes on Escape", async () => {
  await render();
  await click(button("Edit seat builder"));
  await click(button("Pick model"));
  const option = document.querySelector<HTMLButtonElement>('[data-testid="portalled-model"]')!;
  await act(async () => option.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  await click(option);
  expect(button("Done")).toBeDefined();
  expect(approve().disabled).toBe(true);
  await act(async () =>
    button("Done").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  expect(button("Done")).toBeUndefined();
  expect(document.activeElement).toBe(button("Edit seat builder"));
  await click(approve());
  expect(resolve.mock.calls[0]?.[1][0].modelSelection.model).toBe("other-model");
});

it("opening and closing a saved persona does not pin runtime defaults", async () => {
  await render();
  await click(button("Edit seat reviewer"));
  await click(button("Instructions"));
  await input("reviewer instructions", "Review authentication");
  await click(button("Done"));
  await click(approve());
  expect(resolve.mock.calls[0]?.[1][1]).toEqual({
    ...proposal.requestedSeats[1],
    instructions: "Review authentication",
  });
});

it("keeps editing and approval unavailable without permission", async () => {
  state.permitted = false;
  await render();
  expect(approve().disabled).toBe(true);
  expect(button("Edit seat builder").disabled).toBe(true);
  expect(button("Add crew member").disabled).toBe(true);
});

it("opens persona selection from its label and resets only runtime overrides on a switch", async () => {
  await render();
  await click(button("Change persona for builder"));
  const sentry = option("builder member", "Sentry");
  expect(sentry).toBeDefined();
  await click(sentry);
  await click(button("Done"));
  await click(approve());
  expect(resolve.mock.calls[0]?.[1][0]).toEqual({
    ...proposal.requestedSeats[0],
    agentId: "sentry",
  });
});

it("allows clearing an access override back to Persona default", async () => {
  await render();
  await click(button("Edit seat reviewer"));
  await click(button("reviewer access"));
  const supervised = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) =>
    item.textContent?.startsWith("Supervised"),
  )!;
  await click(supervised);
  await click(button("Done"));
  expect(container.textContent).toContain("Asks for approvals");
  await click(button("Edit seat reviewer"));
  await click(button("reviewer access"));
  const inherited = option("reviewer access", "Persona default");
  await click(inherited);
  await click(button("Done"));
  expect(container.textContent).not.toContain("Edited");
  expect(container.textContent).not.toContain("Asks for approvals");
  await click(approve());
  expect(resolve.mock.calls[0]?.[1][1]).toEqual(proposal.requestedSeats[1]);
});

it("clears an original playbook swap once a fresh preview resolves the matching persona", async () => {
  const swap = { stepId: "review", wanted: "critic", seatPersona: "sentry", wantedProblem: null };
  state.preview.mockImplementation(
    async (environment: EnvironmentId, request: CrewProposalPreviewRequest) => {
      const result = await preview(environment, request);
      return {
        ...result,
        seats: result.seats.map((runtime) =>
          runtime.seat === "reviewer" &&
          request.seats?.find((seat) => seat.seat === "reviewer")?.agentId !== "critic"
            ? { ...runtime, personaSwaps: [swap] }
            : runtime,
        ),
      };
    },
  );
  await render({
    proposal: {
      ...proposal,
      requestedSeats: [
        proposal.requestedSeats[0]!,
        { ...proposal.requestedSeats[1]!, steps: ["review"], personaSwaps: [swap] },
      ],
    },
  });
  expect(container.textContent).toContain("wants critic; reviewer is sentry");
  await click(button("Change persona for reviewer"));
  const critic = option("reviewer member", "Critic");
  await click(critic);
  expect(container.textContent).not.toContain("wants critic");
  await click(button("Done"));
  expect(container.textContent).not.toContain("wants critic");
});

it("coalesces typing previews, applies runtime picks immediately, and flushes text on Done", async () => {
  vi.useFakeTimers();
  await render();
  await click(button("Edit seat builder"));
  const calls = state.preview.mock.calls.length;
  await input("builder instructions", "One");
  await input("builder instructions", "Two");
  expect(state.preview).toHaveBeenCalledTimes(calls);
  expect(container.textContent).toContain("Edited");
  await act(async () => vi.advanceTimersByTime(299));
  expect(state.preview).toHaveBeenCalledTimes(calls);
  await act(async () => vi.advanceTimersByTime(1));
  expect(state.preview).toHaveBeenCalledTimes(calls + 1);
  await click(button("Pick model"));
  await click(document.querySelector<HTMLButtonElement>('[data-testid="portalled-model"]')!);
  expect(state.preview).toHaveBeenCalledTimes(calls + 2);
  await input("builder instructions", "Final instructions");
  await click(button("Done"));
  expect(state.preview).toHaveBeenCalledTimes(calls + 3);
  await act(async () => vi.advanceTimersByTime(300));
  expect(state.preview).toHaveBeenCalledTimes(calls + 3);
  await click(approve());
  expect(resolve.mock.calls[0]?.[1][0].instructions).toBe("Final instructions");
});

it("keeps approval disabled after Done until the edited roster preview resolves", async () => {
  await render();
  let finish!: (result: CrewProposalPreviewResponse) => void;
  state.preview.mockImplementation(
    () =>
      new Promise<CrewProposalPreviewResponse>((resolve) => {
        finish = resolve;
      }),
  );
  await click(button("Edit seat builder"));
  await input("builder instructions", "Updated");
  await click(button("Done"));
  expect(approve().disabled).toBe(true);
  const request = state.preview.mock.lastCall![1] as CrewProposalPreviewRequest;
  await act(async () => finish(await preview(EnvironmentId.make("test"), request)));
  expect(approve().disabled).toBe(false);
});

it("shows unavailable runtime after a failed preview rather than an endless resolving label", async () => {
  state.preview.mockRejectedValue(new Error("Provider unavailable"));
  await render();
  expect(container.textContent).toContain("Runtime unavailable");
  expect(container.textContent).not.toContain("Resolving runtime");
  expect(approve().disabled).toBe(true);
});

it("uses the resolved existing-worktree branch instead of its path", async () => {
  state.preview.mockImplementation(
    async (environment: EnvironmentId, request: CrewProposalPreviewRequest) => {
      const result = await preview(environment, request);
      return {
        ...result,
        seats: result.seats.map((runtime) =>
          runtime.workspace?.type === "existing_worktree"
            ? { ...runtime, workspace: { ...runtime.workspace, branch: "fix/payments" } }
            : runtime,
        ),
      };
    },
  );
  await render({
    proposal: {
      ...proposal,
      requestedSeats: [
        {
          ...proposal.requestedSeats[0]!,
          workspace: { type: "existing_worktree", worktreePath: "/repo/worktrees/payments" },
        },
        proposal.requestedSeats[1]!,
      ],
    },
  });
  expect(container.textContent).toContain("Existing worktree on fix/payments");
  expect(container.textContent).not.toContain("/repo/worktrees/payments");
});

it("retains the Captain label in the Inbox while omitting it from the Captain's own gate", async () => {
  await render();
  expect(container.textContent).not.toContain("Release Captain");
  await render({ onOpenCaptain: () => {} });
  expect(container.textContent).toContain("Captain: Release Captain");
});

it("prevents changes and approval while busy", async () => {
  await render({ busy: true });
  expect(button("Working…").disabled).toBe(true);
  expect(button("Edit seat builder").disabled).toBe(true);
  expect(button("Add crew member").disabled).toBe(true);
});

it("ignores an old row-default preview and approves only with the eventual full-roster token", async () => {
  await render();
  const pending: Array<{
    request: CrewProposalPreviewRequest;
    resolve: (value: CrewProposalPreviewResponse) => void;
  }> = [];
  state.preview.mockImplementation(
    (_environment: EnvironmentId, request: CrewProposalPreviewRequest) =>
      new Promise<CrewProposalPreviewResponse>((resolve) => pending.push({ request, resolve })),
  );
  await click(button("Add crew member"));
  await click(button("New seat member"));
  const sentry = option("New seat member", "Sentry");
  await click(sentry);
  expect(pending).toHaveLength(2);
  const old = await preview(EnvironmentId.make("test"), pending[0]!.request);
  await act(async () =>
    pending[0]!.resolve({
      ...old,
      seats: old.seats.map((runtime) => ({ ...runtime, reasoning: "Old custom reasoning" })),
    }),
  );
  expect(container.textContent).not.toContain("Old custom reasoning");
  const latest = await preview(EnvironmentId.make("test"), pending[1]!.request);
  await act(async () =>
    pending[1]!.resolve({
      ...latest,
      approvalToken: "row-only-token",
      seats: latest.seats.map((runtime) => ({ ...runtime, reasoning: "New persona reasoning" })),
    }),
  );
  expect(container.textContent).toContain("New persona reasoning");
  await input("New seat name", "manual");
  await click(button("Done"));
  expect(approve().disabled).toBe(true);
  expect(resolve).not.toHaveBeenCalled();
  const full = pending.at(-1)!;
  expect(full.request.seats).toHaveLength(3);
  await act(async () =>
    full.resolve({
      ...(await preview(EnvironmentId.make("test"), full.request)),
      approvalToken: "full-roster-token",
    }),
  );
  await click(approve());
  expect(resolve).toHaveBeenCalledWith(
    "approve",
    expect.arrayContaining([expect.objectContaining({ seat: "manual", agentId: "sentry" })]),
    "full-roster-token",
  );
});

it.each([
  { type: "worktree" as const, baseRef: "" },
  { type: "existing_worktree" as const, worktreePath: "/repo/deleted-worktree" },
])(
  "keeps the last member's workspace repairable after the first preview rejects $type",
  async (workspace) => {
    state.preview.mockImplementation(
      async (environment: EnvironmentId, request: CrewProposalPreviewRequest) => {
        if (request.seats?.some((seat) => seat.workspace?.type !== "shared"))
          throw new Error("Workspace no longer available");
        return {
          ...(await preview(environment, request)),
          workspaceOptions: { cwd: "/repo", currentBranch: null, worktrees: [] },
        };
      },
    );
    await render({
      proposal: { ...proposal, requestedSeats: [{ ...proposal.requestedSeats[0]!, workspace }] },
    });
    expect(approve().disabled).toBe(true);
    expect(button("Remove seat builder").disabled).toBe(true);
    await click(button("Edit seat builder"));
    expect(button("builder workspace")).toBeDefined();
    await click(button("builder workspace"));
    await click(option("builder workspace", "Captain's checkout"));
    await click(button("Done"));
    expect(approve().disabled).toBe(false);
    await click(approve());
    expect(resolve).toHaveBeenCalledWith(
      "approve",
      [expect.objectContaining({ seat: "builder", workspace: { type: "shared" } })],
      expect.stringContaining("token:"),
    );
  },
);

it("keeps the workspace controls mounted when a loaded selection fails its next preview", async () => {
  state.preview.mockImplementation(
    async (environment: EnvironmentId, request: CrewProposalPreviewRequest) => {
      if (request.seats?.some((seat) => seat.workspace?.type === "worktree"))
        throw new Error("Invalid base branch");
      return {
        ...(await preview(environment, request)),
        workspaceOptions: { cwd: "/repo", currentBranch: null, worktrees: [] },
      };
    },
  );
  await render();
  await click(button("Edit seat builder"));
  const trigger = button("builder workspace");
  await click(trigger);
  await click(option("builder workspace", "New worktree"));
  expect(container.textContent).toContain("Invalid base branch");
  expect(button("builder workspace")).toBe(trigger);
  expect(trigger.isConnected).toBe(true);
  expect(state.preview).toHaveBeenCalledTimes(2);
  await click(button("builder workspace"));
  await click(option("builder workspace", "Captain's checkout"));
  await click(button("Done"));
  expect(approve().disabled).toBe(false);
});
