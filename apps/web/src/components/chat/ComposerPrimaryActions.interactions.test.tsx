import { RunId } from "@t3tools/contracts";
import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

vi.mock("~/hooks/useSettings", () => ({ useEnvironmentIdentificationMode: () => "none" }));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: () => null,
  useSidebarStageBackdropVariant: () => null,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipPopup: () => null,
  TooltipTrigger: ({
    render,
    children,
  }: {
    render: ReactElement<{ children?: ReactNode }>;
    children?: ReactNode;
  }) => cloneElement(render, {}, children ?? render.props.children),
}));

describe("composer primary action follows actual modifiers and provider behavior", () => {
  it.each(["steer-now", "interrupt-restart"] as const)(
    "switches %s to queue only while the modifier is held, and resets after paste",
    async (actKind) => {
      const listeners = new Map<string, (event: unknown) => void>();
      vi.stubGlobal("window", {
        addEventListener: (event: string, listener: (event: unknown) => void) =>
          listeners.set(event, listener),
        removeEventListener: (event: string) => listeners.delete(event),
      });
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      let renderer: ReactTestRenderer | undefined;
      try {
        await act(() => {
          renderer = create(
            <ComposerPrimaryActions
              compact
              pendingAction={null}
              isRunning
              steerState={{ kind: "steerable", act: actKind, runId: RunId.make("active") }}
              showPlanFollowUpPrompt={false}
              promptHasText
              isSendBusy={false}
              sendDisabledReason={null}
              isConnecting={false}
              isEnvironmentUnavailable={false}
              isPreparingWorktree={false}
              hasSendableContent
              onPreviousPendingQuestion={() => {}}
              onInterrupt={() => {}}
              onImplementPlanInNewThread={() => {}}
            />,
          );
        });
        const label = () => renderer!.root.findByType("button").props["aria-label"];
        const expected =
          actKind === "steer-now" ? "Steer now" : "Interrupt and restart with this message";
        expect(label()).toBe(expected);
        await act(() => listeners.get("keydown")!({ key: "Meta", type: "keydown" }));
        expect(label()).toBe("Queue message");
        await act(() => listeners.get("keyup")!({ key: "Meta", type: "keyup" }));
        expect(label()).toBe(expected);
        await act(() => listeners.get("keydown")!({ key: "Control", type: "keydown" }));
        expect(label()).toBe("Queue message");
        await act(() => listeners.get("paste")!({}));
        expect(label()).toBe(expected);
      } finally {
        await act(() => renderer?.unmount());
        vi.unstubAllGlobals();
      }
    },
  );
});
