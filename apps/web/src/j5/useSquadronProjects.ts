import { useMemo } from "react";

import { useSettingsProjectGroups } from "../components/settings/useSettingsProjectGroups";
import { useSquadronDirectory } from "./squadron/SquadronDirectory";
import { createSquadronProjectLookup } from "./squadronProject.logic";

/**
 * Upstream's logical projects for the J5 views that still read a Squadron-keyed ledger (Fleet,
 * Inbox): look a row up by its thread's project, or by the project its Squadron references.
 */
export function useSquadronProjects() {
  const groups = useSettingsProjectGroups();
  const { squadrons } = useSquadronDirectory();
  return useMemo(() => createSquadronProjectLookup({ groups, squadrons }), [groups, squadrons]);
}
