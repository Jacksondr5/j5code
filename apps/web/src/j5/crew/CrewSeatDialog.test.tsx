import { ProviderInstanceId } from "@t3tools/contracts";
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
vi.mock("./CrewSeatEditor", () => ({ CrewSeatEditor: () => null }));

import { CrewSeatDialog } from "./CrewSeatDialog";
import { CrewSeatEditor } from "./CrewSeatEditor";
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

  it("starts additions as custom and requires a valid name before publishing", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn((draft) => addSeat([seat], draft).error);
    await act(async () => {
      renderer = create(
        <CrewSeatDialog
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
