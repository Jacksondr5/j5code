import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import type { CrewProposalPreviewResponse, CrewProposalSeat } from "@t3tools/contracts/j5";
import { act, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { previewCrewProposal } = vi.hoisted(() => ({ previewCrewProposal: vi.fn() }));
vi.mock("./crewProposalsClient", () => ({ previewCrewProposal }));
import { useCrewProposalPreview } from "./useCrewProposalPreview";

const environmentId = EnvironmentId.make("crew-preview");
const seats: ReadonlyArray<CrewProposalSeat> = [
  { seat: "reviewer", agentId: null, reason: "Review", instructions: "Review the patch" },
];
const response: CrewProposalPreviewResponse = {
  proposalId: "proposal:1",
  approvalToken: "preview:1",
  seats: [
    {
      seat: "reviewer",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-6-astra",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
      runtimeMode: "full-access",
      provider: "OpenAI",
      harness: "Codex",
      model: "GPT-6-Astra",
      reasoning: "High",
      access: "Full access",
    },
  ],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
let renderer: ReactTestRenderer | null;
let result: ReturnType<typeof useCrewProposalPreview>;
function Surface(props: {
  seats: ReadonlyArray<CrewProposalSeat>;
  environmentId: EnvironmentId | null;
  busy?: boolean;
  proposalId?: string;
}) {
  const preview = useCrewProposalPreview(
    props.environmentId,
    props.proposalId ?? "proposal:1",
    props.seats,
    props.busy ?? false,
  );
  useEffect(() => {
    result = preview;
  }, [preview]);
  return null;
}
async function render(
  nextSeats = seats,
  nextEnvironment: EnvironmentId | null = environmentId,
  busy = false,
) {
  await act(async () => {
    const element = <Surface seats={nextSeats} environmentId={nextEnvironment} busy={busy} />;
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
}
beforeEach(() => {
  renderer = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  previewCrewProposal.mockReset();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe("crew runtime preview lifecycle", () => {
  it("withholds approval while loading and ignores a response for a previous roster", async () => {
    const first = deferred<CrewProposalPreviewResponse>();
    const second = deferred<CrewProposalPreviewResponse>();
    previewCrewProposal.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await render();
    expect(result.loading).toBe(true);
    expect(result.data).toBeNull();
    const changed = [{ ...seats[0]!, instructions: "Review only authentication" }];
    await render(changed);
    await act(async () => first.resolve(response));
    expect(result.data).toBeNull();
    await act(async () => second.resolve({ ...response, approvalToken: "preview:2" }));
    expect(result.data?.approvalToken).toBe("preview:2");
    expect(previewCrewProposal).toHaveBeenLastCalledWith(environmentId, {
      proposalId: "proposal:1",
      seats: changed,
    });
  });

  it.each([
    [
      "harness",
      {
        modelSelection: {
          ...response.seats[0]!.modelSelection,
          instanceId: ProviderInstanceId.make("codex-other"),
        },
      },
    ],
    ["model", { modelSelection: { ...response.seats[0]!.modelSelection, model: "other-model" } }],
    [
      "reasoning",
      {
        modelSelection: {
          ...response.seats[0]!.modelSelection,
          options: [{ id: "reasoningEffort", value: "medium" }],
        },
      },
    ],
    ["access", { runtimeMode: "approval-required" as const }],
  ])("invalidates approval when the custom %s changes", async (_field, change) => {
    const next = deferred<CrewProposalPreviewResponse>();
    previewCrewProposal.mockResolvedValueOnce(response).mockReturnValueOnce(next.promise);
    await render();
    expect(result.data).toEqual(response);
    const edited = [{ ...seats[0]!, ...change }];
    await render(edited);
    expect(result.data).toBeNull();
    expect(result.runtimeSeats).toBeNull();
    expect(result.loading).toBe(true);
    expect(previewCrewProposal).toHaveBeenLastCalledWith(environmentId, {
      proposalId: "proposal:1",
      seats: edited,
    });
    await act(async () => next.resolve({ ...response, approvalToken: "updated-runtime" }));
    expect(result.data?.approvalToken).toBe("updated-runtime");
  });

  it("invalidates displayed runtime on environment changes and failed previews can retry", async () => {
    previewCrewProposal
      .mockResolvedValueOnce(response)
      .mockRejectedValueOnce(new Error("Provider unavailable"))
      .mockResolvedValueOnce(response);
    await render();
    expect(result.data).toEqual(response);
    await render(seats, EnvironmentId.make("another-environment"));
    expect(result.data).toBeNull();
    expect(result.error).toBe("Provider unavailable");
    await act(async () => result.refresh());
    expect(result.data).toEqual(response);
  });

  it("retains runtime disclosure while approving but requires a fresh token afterward", async () => {
    const next = deferred<CrewProposalPreviewResponse>();
    previewCrewProposal.mockResolvedValueOnce(response).mockReturnValueOnce(next.promise);
    await render();
    // Match the card: invalidate the approval token, then enter busy in the same event.
    await act(async () => {
      result.refresh();
      renderer!.update(<Surface seats={seats} environmentId={environmentId} busy />);
    });
    expect(result.data).toBeNull();
    expect(result.runtimeSeats).toEqual(response.seats);
    expect(result.loading).toBe(false);
    expect(previewCrewProposal).toHaveBeenCalledTimes(1);
    await render(seats, environmentId, false);
    expect(previewCrewProposal).toHaveBeenCalledTimes(2);
    expect(result.data).toBeNull();
    expect(result.runtimeSeats).toBeNull();
    expect(result.loading).toBe(true);
    await act(async () => next.resolve({ ...response, approvalToken: "preview:2" }));
    expect(result.data?.approvalToken).toBe("preview:2");
    expect(result.runtimeSeats).toEqual(response.seats);
  });

  it("never retains busy runtime disclosure for a changed roster, environment, or proposal", async () => {
    previewCrewProposal.mockResolvedValueOnce(response);
    await render();
    await render([{ ...seats[0]!, instructions: "Changed instructions" }], environmentId, true);
    expect(result.runtimeSeats).toBeNull();
    expect(result.data).toBeNull();
    await render(seats, EnvironmentId.make("another-environment"), true);
    expect(result.runtimeSeats).toBeNull();
    await act(async () => {
      renderer!.update(
        <Surface seats={seats} environmentId={environmentId} proposalId="proposal:2" busy />,
      );
    });
    expect(result.runtimeSeats).toBeNull();
    expect(previewCrewProposal).toHaveBeenCalledTimes(1);
  });

  it("never accepts incomplete runtime rows or an unavailable environment", async () => {
    previewCrewProposal.mockResolvedValue({ ...response, seats: [] });
    await render();
    expect(result.data).toBeNull();
    expect(result.error).toContain("incomplete");
    await render(seats, null);
    expect(result.data).toBeNull();
    expect(result.loading).toBe(false);
    expect(result.error).toContain("Connect");
    expect(previewCrewProposal).toHaveBeenCalledTimes(1);
  });
});
