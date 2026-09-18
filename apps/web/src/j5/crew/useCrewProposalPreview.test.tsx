import { EnvironmentId } from "@t3tools/contracts";
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
      provider: "OpenAI",
      harness: "Codex",
      model: "GPT-6-Astra",
      reasoning: "High",
      access: "Repository write",
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
}) {
  const preview = useCrewProposalPreview(
    props.environmentId,
    "proposal:1",
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

  it("requires a fresh preview after an approval attempt and does not resolve while busy", async () => {
    previewCrewProposal.mockResolvedValue(response);
    await render();
    await act(async () => result.refresh());
    await render(seats, environmentId, true);
    expect(result.data).toBeNull();
    const calls = previewCrewProposal.mock.calls.length;
    await render(seats, environmentId, false);
    expect(previewCrewProposal).toHaveBeenCalledTimes(calls + 1);
    expect(result.data).toEqual(response);
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
