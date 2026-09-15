import { presentAgentPersonaCatalog } from "@t3tools/client-runtime/j5/agent-personas";
import type { EnvironmentId } from "@t3tools/contracts";

import { useEnvironmentQuery } from "../../state/query";
import { agentPersonaEnvironment } from "../agents/agentPersonaAtoms";
import { CREW_CAPTAIN_PERSONA_ID } from "./crewCommand";

/** True when `/crew` can launch here, false when the library lacks a Captain, null while loading. */
export function useCrewCaptainAvailability(environmentId: EnvironmentId | null): boolean | null {
  const catalog = useEnvironmentQuery(
    environmentId === null ? null : agentPersonaEnvironment.catalog({ environmentId, input: {} }),
  );
  if (catalog.data === null || catalog.data === undefined) return null;
  return presentAgentPersonaCatalog(catalog.data).some(
    (agent) => agent.personaId === CREW_CAPTAIN_PERSONA_ID && agent.availability === "available",
  );
}
