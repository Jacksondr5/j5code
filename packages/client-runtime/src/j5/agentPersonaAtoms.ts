import { J5_AGENT_PERSONA_WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "../state/runtime.ts";

/** Environment-scoped atoms for the J5 agent persona library RPCs; web and mobile each build one. */
export function createAgentPersonaEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    catalog: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:j5-agent-personas:catalog",
      tag: J5_AGENT_PERSONA_WS_METHODS.getAgentPersonaCatalog,
      staleTimeMs: 0,
    }),
    importAgentPersonas: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:j5-agent-personas:import",
      tag: J5_AGENT_PERSONA_WS_METHODS.importAgentPersonas,
    }),
    editImportedAgentPersona: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:j5-agent-personas:edit-imported",
      tag: J5_AGENT_PERSONA_WS_METHODS.editImportedAgentPersona,
    }),
    setImportedAgentPersonaEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:j5-agent-personas:set-imported-enabled",
      tag: J5_AGENT_PERSONA_WS_METHODS.setImportedAgentPersonaEnabled,
    }),
    removeImportedAgentPersona: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:j5-agent-personas:remove-imported",
      tag: J5_AGENT_PERSONA_WS_METHODS.removeImportedAgentPersona,
    }),
    removeSourceAgentPersona: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:j5-agent-personas:remove-source",
      tag: J5_AGENT_PERSONA_WS_METHODS.removeSourceAgentPersona,
    }),
    removeAgentPersona: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:j5-agent-personas:remove",
      tag: J5_AGENT_PERSONA_WS_METHODS.removeAgentPersona,
    }),
    restoreSourceAgentPersona: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:j5-agent-personas:restore-source",
      tag: J5_AGENT_PERSONA_WS_METHODS.restoreSourceAgentPersona,
    }),
    createAgentPersona: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:j5-agent-personas:create",
      tag: J5_AGENT_PERSONA_WS_METHODS.createAgentPersona,
    }),
    readAgentPersona: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:j5-agent-personas:read",
      tag: J5_AGENT_PERSONA_WS_METHODS.readAgentPersona,
    }),
  };
}
