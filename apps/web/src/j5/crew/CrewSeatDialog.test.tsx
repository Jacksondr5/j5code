import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import type { CrewProposalSeatRuntime } from "@t3tools/contracts/j5";
import { act, type PropsWithChildren } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../components/ui/dialog", () => {
  const Part = ({ children }: PropsWithChildren) => <div>{children}</div>;
  return {
    Dialog: Part,
    DialogDescription: Part,
    DialogFooter: Part,
    DialogHeader: Part,
    DialogPanel: Part,
    DialogPopup: Part,
    DialogTitle: Part,
  };
});
vi.mock("../../components/ui/button", () => ({
  Button: (props: React.ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("./crewProposalsClient", () => ({ previewCrewProposal: vi.fn() }));
vi.mock("./CrewSeatEditor", () => ({ CrewSeatEditor: () => null }));

import { CrewSeatDialog } from "./CrewSeatDialog";
import { CrewSeatEditor } from "./CrewSeatEditor";
import { previewCrewProposal } from "./crewProposalsClient";
import { chooseCrewSeatPersona, resolvedCrewSeatDraft } from "./crewSeatRuntime";
import { addSeat, saveSeat } from "./crewProposalDraft";

const seat = {
  seat: "reviewer",
  agentId: null,
  reason: "Review",
  instructions: "Review the patch",
};
const runtime: CrewProposalSeatRuntime = {
  seat: "reviewer",
  provider: "OpenAI",
  harness: "Codex",
  model: "GPT-6-Astra",
  reasoning: "High",
  access: "Full access",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-6-astra",
    options: [{ id: "reasoningEffort", value: "high" }],
  },
  runtimeMode: "full-access",
};
let renderer: ReactTestRenderer | null;
beforeEach(() => {
  renderer = null;
  vi.mocked(previewCrewProposal).mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

const editor = () =>
  renderer!.root.findByType(CrewSeatEditor).props as React.ComponentProps<typeof CrewSeatEditor>;
const submit = async () => {
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
};

describe("crew member dialog draft lifecycle", () => {
  it("keeps runtime changes local and discards them when cancelled", async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    await act(async () => {
      renderer = create(
        <CrewSeatDialog
          proposalId="proposal:1"
          previewSeatName="reviewer"
          seat={seat}
          runtime={runtime}
          environmentId={null}
          agents={[]}
          disabled={false}
          onSave={onSave}
          onClose={onClose}
        />,
      );
    });
    expect(editor().value.modelSelection).toEqual(runtime.modelSelection);
    await act(async () =>
      editor().onChange({
        ...editor().value,
        runtimeMode: "approval-required",
        instructions: "Unsaved edits",
      }),
    );
    expect(editor().value.instructions).toBe("Unsaved edits");
    expect(onSave).not.toHaveBeenCalled();
    expect(seat.instructions).toBe("Review the patch");
    await act(async () =>
      renderer!.root
        .findAllByType("button")
        .find((button) => button.props.children === "Cancel")!
        .props.onClick(),
    );
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("leaves invalid edits open, then publishes one validated roster update on Save", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn((draft) => saveSeat([seat], seat.seat, draft).error);
    await act(async () => {
      renderer = create(
        <CrewSeatDialog
          proposalId="proposal:1"
          previewSeatName="reviewer"
          seat={seat}
          runtime={runtime}
          environmentId={null}
          agents={[]}
          disabled={false}
          onSave={onSave}
          onClose={onClose}
        />,
      );
    });
    await act(async () => editor().onChange({ ...editor().value, instructions: "" }));
    await submit();
    expect(onClose).not.toHaveBeenCalled();
    expect(renderer!.root.findByProps({ role: "alert" }).children.join("")).toContain(
      "instructions",
    );
    await act(async () =>
      editor().onChange({
        ...editor().value,
        instructions: "Check authentication",
        runtimeMode: "approval-required",
      }),
    );
    await submit();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({
        instructions: "Check authentication",
        modelSelection: runtime.modelSelection,
        runtimeMode: "approval-required",
      }),
    );
  });

  it("prefills a proposed saved persona and saves its edited runtime without changing its identity", async () => {
    const saved = { ...seat, agentId: "sentry" };
    let roster = [saved];
    await act(async () => {
      renderer = create(
        <CrewSeatDialog
          proposalId="proposal:1"
          previewSeatName="reviewer"
          seat={saved}
          runtime={runtime}
          environmentId={null}
          agents={[]}
          disabled={false}
          onClose={() => {}}
          onSave={(draft) => {
            const result = saveSeat(roster, saved.seat, draft);
            roster = result.seats as typeof roster;
            return result.error;
          }}
        />,
      );
    });
    await act(async () =>
      editor().onChange({
        ...resolvedCrewSeatDraft(editor().value, editor().runtime),
        runtimeMode: "approval-required",
      }),
    );
    expect(roster[0]).toEqual(saved);
    await submit();
    expect(roster[0]).toEqual({
      ...saved,
      modelSelection: runtime.modelSelection,
      runtimeMode: "approval-required",
    });
  });

  it("keeps persona defaults when saving only instructions", async () => {
    const onSave = vi.fn(
      (_draft: Parameters<React.ComponentProps<typeof CrewSeatDialog>["onSave"]>[0]) => null,
    );
    await act(async () => {
      renderer = create(
        <CrewSeatDialog
          proposalId="proposal:1"
          previewSeatName="reviewer"
          seat={{ ...seat, agentId: "sentry" }}
          runtime={runtime}
          environmentId={null}
          agents={[]}
          disabled={false}
          onClose={() => {}}
          onSave={onSave}
        />,
      );
    });
    await act(async () => editor().onChange({ ...editor().value, instructions: "Check auth" }));
    await submit();
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("modelSelection");
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("runtimeMode");
  });

  it("loads a manually selected persona's defaults and ignores an older response", async () => {
    const pending: Array<(value: Awaited<ReturnType<typeof previewCrewProposal>>) => void> = [];
    vi.mocked(previewCrewProposal).mockImplementation(
      () => new Promise((resolve) => pending.push(resolve)),
    );
    const onSave = vi.fn((draft) => addSeat([], draft).error);
    await act(async () => {
      renderer = create(
        <CrewSeatDialog
          proposalId="proposal:1"
          previewSeatName="reviewer"
          seat={null}
          environmentId={EnvironmentId.make("test")}
          agents={[]}
          disabled={false}
          onClose={() => {}}
          onSave={onSave}
        />,
      );
    });
    await act(async () =>
      editor().onChange(chooseCrewSeatPersona({ ...editor().value, seat: "manual" }, "sentry")),
    );
    await act(async () =>
      pending[0]!({
        proposalId: "proposal:1",
        approvalToken: "old",
        seats: [{ ...runtime, model: "Wrong custom default" }],
      }),
    );
    expect(editor().runtime).toBeUndefined();
    await act(async () =>
      pending[1]!({ proposalId: "proposal:1", approvalToken: "new", seats: [runtime] }),
    );
    expect(editor().runtime).toEqual(runtime);
    await act(async () =>
      editor().onChange({
        ...resolvedCrewSeatDraft(editor().value, editor().runtime),
        runtimeMode: "approval-required",
      }),
    );
    await submit();
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "sentry",
        modelSelection: runtime.modelSelection,
        runtimeMode: "approval-required",
      }),
    );
  });

  it("starts additions as custom and requires a valid name before publishing", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn((draft) => addSeat([seat], draft).error);
    await act(async () => {
      renderer = create(
        <CrewSeatDialog
          proposalId="proposal:1"
          previewSeatName="reviewer"
          seat={null}
          environmentId={null}
          agents={[]}
          disabled={false}
          onSave={onSave}
          onClose={onClose}
        />,
      );
    });
    await act(async () =>
      editor().onChange({
        ...editor().value,
        instructions: "Review security",
        modelSelection: runtime.modelSelection,
        runtimeMode: "approval-required",
      }),
    );
    await submit();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => editor().onChange({ ...editor().value, seat: "security" }));
    await submit();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({
        seat: "security",
        modelSelection: runtime.modelSelection,
        runtimeMode: "approval-required",
      }),
    );
  });
});
