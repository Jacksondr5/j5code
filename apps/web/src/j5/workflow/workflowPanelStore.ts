import { create } from "zustand";

interface WorkflowPanelState {
  selectedRunId: string | null;
  scope: string;
  offset: number;
  selectRun: (id: string | null) => void;
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
  selectRun: (selectedRunId) => set({ selectedRunId }),
  setOffset: (scope, offset) => set({ scope, offset }),
}));
