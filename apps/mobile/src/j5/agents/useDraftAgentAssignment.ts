import { draftAgentAssignmentPreview } from "@t3tools/client-runtime/j5/agent-personas";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { clearDraftAgent, useDraftAgentPersonaId } from "./agentDraftState";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";

/** The draft screen's view of its chosen agent: the preview assignment plus a way to clear it. */
export function useDraftAgentAssignment(
  draftKey: string | null,
  environmentId: EnvironmentId | null,
) {
  const personaId = useDraftAgentPersonaId(draftKey);
  const catalog = useEnvironmentQuery(
    personaId !== null && environmentId !== null
      ? agentPersonaEnvironment.catalog({ environmentId, input: {} })
      : null,
  );
  const assignment = useMemo(
    () => (personaId === null ? null : draftAgentAssignmentPreview(personaId, catalog.data)),
    [personaId, catalog.data],
  );
  const clear = useCallback(() => {
    if (draftKey !== null) clearDraftAgent(draftKey);
  }, [draftKey]);
  return { personaId, assignment, clear };
}
