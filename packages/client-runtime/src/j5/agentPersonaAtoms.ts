import { J5_AGENT_PERSONA_WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  EnvironmentRpcUnavailableError,
  request,
  type EnvironmentRpcInput,
} from "../rpc/client.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "../state/runtime.ts";
import { connectionIsKnownNarrow } from "./sharing.ts";

/** Environment-scoped atoms for the J5 agent persona library RPCs; web and mobile each build one. */
export function createAgentPersonaEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    catalog: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:j5-agent-personas:catalog",
      tag: J5_AGENT_PERSONA_WS_METHODS.getAgentPersonaCatalog,
      // Pickers all over the chat view mount this. Personas are the server's (People and access
      // AC23), so once the connection is known to reach less than the server it is not sent.
      execute: Effect.fn("j5.agentPersonas.catalog")(function* (
        input: EnvironmentRpcInput<typeof J5_AGENT_PERSONA_WS_METHODS.getAgentPersonaCatalog>,
      ) {
        if (yield* connectionIsKnownNarrow) {
          const supervisor = yield* EnvironmentSupervisor;
          return yield* new EnvironmentRpcUnavailableError({
            environmentId: supervisor.target.environmentId,
            message: "Personas are not shared with you on this server.",
          });
        }
        return yield* request(J5_AGENT_PERSONA_WS_METHODS.getAgentPersonaCatalog, input);
      }),
      staleTimeMs: 0,
    }),
    importAgentPersonas: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:j5-agent-personas:import",
      tag: J5_AGENT_PERSONA_WS_METHODS.importAgentPersonas,
    }),
    listImportFiles: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:j5-agent-personas:list-import-files",
      tag: J5_AGENT_PERSONA_WS_METHODS.listAgentPersonaImportFiles,
    }),
    readImportFiles: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:j5-agent-personas:read-import-files",
      tag: J5_AGENT_PERSONA_WS_METHODS.readAgentPersonaImportFiles,
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
    usage: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:j5-agent-personas:usage",
      tag: J5_AGENT_PERSONA_WS_METHODS.getAgentPersonaUsage,
      staleTimeMs: 0,
    }),
    librarySources: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:j5-agent-personas:library-sources",
      tag: J5_AGENT_PERSONA_WS_METHODS.getAgentPersonaLibrarySources,
      staleTimeMs: 0,
    }),
    setAgentPersonaEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:j5-agent-personas:set-enabled",
      tag: J5_AGENT_PERSONA_WS_METHODS.setAgentPersonaEnabled,
    }),
    /** Rows recorded by runs before handoffs were retired; read with `input: {}` so every chip shares one query. */
    handoffs: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:j5-agent-personas:handoffs",
      tag: J5_AGENT_PERSONA_WS_METHODS.getAgentHandoffs,
      staleTimeMs: 30_000,
    }),
    setLibraryFolders: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:j5-agent-personas:set-library-folders",
      tag: J5_AGENT_PERSONA_WS_METHODS.setAgentPersonaLibraryFolders,
    }),
  };
}
