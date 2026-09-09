import { create } from "zustand";
import type { RunDetailTab } from "./runsSearch";

interface WorkflowPanelState {
  selectedRunId: string | null;
  scope: string;
  offset: number;
  tab: RunDetailTab;
  selectRun: (id: string | null) => void;
  setTab: (tab: RunDetailTab) => void;
  setOffset: (scope: string, offset: number) => void;
}

export const effectiveWorkflowPanelOffset = (
  state: Pick<WorkflowPanelState, "scope" | "offset">,
  ambientScope: string,
) => (state.scope === ambientScope ? state.offset : 0);

export const useWorkflowPanelStore = create<WorkflowPanelState>((set) => ({
  selectedRunId: null,
  scope: "",
  offset: 0,
  tab: "overview",
  selectRun: (selectedRunId) => set({ selectedRunId, tab: "overview" }),
  setTab: (tab) => set({ tab }),
  setOffset: (scope, offset) => set({ scope, offset }),
}));
