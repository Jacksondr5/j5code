import { create } from "zustand";
import type { RunDetailTab } from "./runsSearch";

interface PlaybookPanelState {
  selectedRunId: string | null;
  selectedEnvironmentId: string | null;
  scope: string;
  offset: number;
  tab: RunDetailTab;
  selectRun: (environmentId: string | null, id: string | null) => void;
  setTab: (tab: RunDetailTab) => void;
  setOffset: (scope: string, offset: number) => void;
}

export const effectivePlaybookPanelOffset = (
  state: Pick<PlaybookPanelState, "scope" | "offset">,
  ambientScope: string,
) => (state.scope === ambientScope ? state.offset : 0);

export const usePlaybookPanelStore = create<PlaybookPanelState>((set) => ({
  selectedRunId: null,
  selectedEnvironmentId: null,
  scope: "",
  offset: 0,
  tab: "overview",
  selectRun: (selectedEnvironmentId, selectedRunId) =>
    set({ selectedEnvironmentId, selectedRunId, tab: "overview" }),
  setTab: (tab) => set({ tab }),
  setOffset: (scope, offset) => set({ scope, offset }),
}));
