import { useGT } from "gt-react-native";

import { useStartsSomewhere } from "../../../j5/sharing/startAccess";
import { useAdaptiveWorkspaceLayout } from "../adaptive-workspace-context";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";

/** What the compose button starts on the selected tab; null where the tab has nothing to start. */
export function useWorkspaceCompose() {
  const gt = useGT();
  const workspace = useWorkspaceTabs();
  const { startNewTask } = useAdaptiveWorkspaceLayout();
  // J5: compose is offered only to someone who may start a thread (FORK.md case 90).
  const startsSomewhere = useStartsSomewhere();
  if (
    !startsSomewhere ||
    !workspace ||
    workspace.settingsOpen ||
    workspace.state.selectedTab !== "threads"
  )
    return null;
  return { label: gt("New chat"), onPress: startNewTask } as const;
}
