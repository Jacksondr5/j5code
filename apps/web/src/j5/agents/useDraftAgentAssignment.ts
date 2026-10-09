import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { draftAgentAssignmentPreview } from "@t3tools/client-runtime/j5/agent-personas";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { clearDraftAgent, useDraftAgentPersonaId } from "./agentDraftState";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";

/** The composer's view of a draft's chosen agent: the preview assignment plus a way to clear it. */
export function useDraftAgentAssignment(
  routeThreadRef: ScopedThreadRef,
  environmentId: EnvironmentId,
  enabled: boolean,
) {
  const draftKey = scopedThreadKey(routeThreadRef);
  const personaId = useDraftAgentPersonaId(enabled ? draftKey : null);
  const catalog = useEnvironmentQuery(
    enabled && personaId !== null
      ? agentPersonaEnvironment.catalog({ environmentId, input: {} })
      : null,
  );
  const assignment = useMemo(
    () => (personaId === null ? null : draftAgentAssignmentPreview(personaId, catalog.data)),
    [personaId, catalog.data],
  );
  const clear = useCallback(() => clearDraftAgent(draftKey), [draftKey]);
  return { enabled, draftKey, personaId, assignment, clear };
}
