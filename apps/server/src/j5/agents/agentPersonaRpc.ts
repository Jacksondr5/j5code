import * as Clock from "effect/Clock";
import {
  AgentPersonaCatalogError,
  AgentPersonaImportConflictError,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  J5_AGENT_PERSONA_WS_METHODS,
  type J5AgentPersonaRpcSchemas,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { stringify as toYaml } from "yaml";

import { definitionDigest, makeAgentPersonaLibrary } from "./agentPersonaLibrary.ts";
import { makeAgentHandoffStore } from "./agentHandoffStore.ts";
import { agentPersonaFolderGitStatus } from "./agentPersonaLibraryGit.ts";
import { agentPersonaPolicyEnforcement } from "./agentPersonaProviderPolicy.ts";
import { buildAgentPersonaCatalog, agentPersonaDefinitionView } from "./agentPersonaRouting.ts";
import { agentPersonaUsage } from "./agentPersonaUsage.ts";

const METHODS = J5_AGENT_PERSONA_WS_METHODS;

/**
 * Spread into `RPC_REQUIRED_SCOPES`; the upstream `satisfies` check still covers every tag. The
 * Persona library configures the server, so changing it, or reading the files it imports from,
 * is an Owner's like any other setting (People and access): only an Owner's level holds
 * `settings:write`.
 */
export const AGENT_PERSONA_RPC_SCOPES = {
  [METHODS.getAgentPersonaCatalog]: AuthOrchestrationReadScope,
  [METHODS.importAgentPersonas]: AuthSettingsWriteScope,
  [METHODS.listAgentPersonaImportFiles]: AuthSettingsWriteScope,
  [METHODS.readAgentPersonaImportFiles]: AuthSettingsWriteScope,
  [METHODS.editImportedAgentPersona]: AuthSettingsWriteScope,
  [METHODS.setImportedAgentPersonaEnabled]: AuthSettingsWriteScope,
  [METHODS.removeImportedAgentPersona]: AuthSettingsWriteScope,
  [METHODS.removeSourceAgentPersona]: AuthSettingsWriteScope,
  [METHODS.removeAgentPersona]: AuthSettingsWriteScope,
  [METHODS.restoreSourceAgentPersona]: AuthSettingsWriteScope,
  [METHODS.createAgentPersona]: AuthSettingsWriteScope,
  [METHODS.readAgentPersona]: AuthOrchestrationReadScope,
  [METHODS.getAgentPersonaUsage]: AuthOrchestrationReadScope,
  [METHODS.getAgentPersonaLibrarySources]: AuthOrchestrationReadScope,
  [METHODS.setAgentPersonaLibraryFolders]: AuthSettingsWriteScope,
  [METHODS.setAgentPersonaEnabled]: AuthSettingsWriteScope,
  [METHODS.getAgentHandoffs]: AuthOrchestrationReadScope,
} as const;

type Input<K extends keyof typeof J5AgentPersonaRpcSchemas> =
  (typeof J5AgentPersonaRpcSchemas)[K]["input"]["Type"];

const isImportConflict = Schema.is(AgentPersonaImportConflictError);
const catalogError = (cause: unknown) => new AgentPersonaCatalogError({ message: String(cause) });

/** Handlers for `J5AgentPersonaRpcGroup`; spread once into the upstream handler object. */
export const makeAgentPersonaRpcHandlers = Effect.fn("j5.makeAgentPersonaRpcHandlers")(
  function* (deps: { readonly providers: Effect.Effect<ReadonlyArray<ServerProvider>> }) {
    const library = yield* makeAgentPersonaLibrary;
    // Usage reads the projections through the session's SqlClient, captured once here.
    const sql = yield* SqlClient.SqlClient;
    const usage = () => agentPersonaUsage().pipe(Effect.provideService(SqlClient.SqlClient, sql));
    const handoffs = yield* makeAgentHandoffStore.pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    return {
      [METHODS.getAgentPersonaCatalog]: Effect.fn(
        "j5.agents.agentPersonaRpc.getAgentPersonaCatalog",
      )(function* (_input: Input<"getAgentPersonaCatalog">) {
        const current = yield* library.catalog().pipe(Effect.mapError(catalogError));
        const providers = yield* deps.providers;
        const now = yield* Clock.currentTimeMillis;
        const catalog = buildAgentPersonaCatalog(providers, current.definitions, now);
        const importedIds = new Set(current.importedIds);
        const digests = new Map(
          [...current.definitions, ...current.removedSources].map((definition) => [
            definition.id,
            definitionDigest(definition),
          ]),
        );
        const orderedEditable = new Map(
          current.definitions
            .filter(({ id }) => importedIds.has(id))
            .map((definition) => [
              definition.id,
              {
                definitionDigest: definitionDigest(definition),
                modelRoute: definition.modelRoute,
              },
            ]),
        );
        const disabledIds = new Set(current.disabledIds);
        const origin = (personaId: string) => {
          const path = current.sourcePaths.get(personaId);
          return importedIds.has(personaId)
            ? { kind: "imported" as const }
            : path === undefined
              ? { kind: "bundled" as const }
              : { kind: "folder" as const, path };
        };
        const removed = buildAgentPersonaCatalog(providers, current.removedSources, now);
        return {
          diagnostics: current.diagnostics,
          personas: [
            ...catalog.personas.map((persona) => ({
              ...persona,
              imported: importedIds.has(persona.personaId),
              origin: origin(persona.personaId),
              definitionDigest: digests.get(persona.personaId)!,
              ...(orderedEditable.has(persona.personaId)
                ? { orderedEditable: orderedEditable.get(persona.personaId)! }
                : {}),
              availability: disabledIds.has(persona.personaId)
                ? { status: "unavailable" as const, reason: "disabled" as const }
                : persona.availability,
            })),
            ...removed.personas.map((persona) => ({
              ...persona,
              imported: false,
              removed: true,
              origin: origin(persona.personaId),
              definitionDigest: digests.get(persona.personaId)!,
              availability: { status: "unavailable" as const, reason: "removed" as const },
            })),
          ],
          policyEnforcement: agentPersonaPolicyEnforcement(),
        };
      }),
      [METHODS.importAgentPersonas]: (input: Input<"importAgentPersonas">) =>
        library
          .importFiles(input)
          .pipe(
            Effect.mapError((cause) => (isImportConflict(cause) ? cause : catalogError(cause))),
          ),
      [METHODS.listAgentPersonaImportFiles]: (input: Input<"listAgentPersonaImportFiles">) =>
        library.listImportFiles(input.directory).pipe(
          Effect.map((files) => ({ files })),
          Effect.mapError(catalogError),
        ),
      [METHODS.readAgentPersonaImportFiles]: (input: Input<"readAgentPersonaImportFiles">) =>
        library.readImportFiles(input.path).pipe(
          Effect.map((files) => ({ files })),
          Effect.mapError(catalogError),
        ),
      [METHODS.editImportedAgentPersona]: (input: Input<"editImportedAgentPersona">) =>
        library.editImported(input).pipe(Effect.mapError(catalogError)),
      [METHODS.setImportedAgentPersonaEnabled]: (input: Input<"setImportedAgentPersonaEnabled">) =>
        library
          .setImportedEnabled(input.personaId, input.enabled)
          .pipe(Effect.mapError(catalogError)),
      [METHODS.removeImportedAgentPersona]: (input: Input<"removeImportedAgentPersona">) =>
        library.removeImported(input.personaId).pipe(Effect.mapError(catalogError)),
      [METHODS.removeSourceAgentPersona]: (input: Input<"removeSourceAgentPersona">) =>
        library.removeSource(input.personaId).pipe(Effect.mapError(catalogError)),
      [METHODS.removeAgentPersona]: (input: Input<"removeAgentPersona">) =>
        library.removeAgent(input.personaId).pipe(Effect.mapError(catalogError)),
      [METHODS.restoreSourceAgentPersona]: (input: Input<"restoreSourceAgentPersona">) =>
        library.restoreSource(input.personaId).pipe(Effect.mapError(catalogError)),
      [METHODS.createAgentPersona]: (input: Input<"createAgentPersona">) =>
        library.createPersona(input).pipe(Effect.mapError(catalogError)),
      [METHODS.readAgentPersona]: Effect.fn("j5.agents.agentPersonaRpc.readAgentPersona")(
        function* (input: Input<"readAgentPersona">) {
          const definition = yield* library
            .read(input.personaId)
            .pipe(Effect.mapError(catalogError));
          const providers = yield* deps.providers;
          const view = yield* Effect.try({
            try: () => agentPersonaDefinitionView(definition, providers),
            catch: catalogError,
          });
          return {
            definition: view,
            fileName: `${definition.id}.yaml`,
            yaml: toYaml(definition, { lineWidth: 0 }),
          };
        },
      ),
      [METHODS.getAgentPersonaUsage]: (_input: Input<"getAgentPersonaUsage">) =>
        usage().pipe(Effect.mapError(catalogError)),
      [METHODS.getAgentPersonaLibrarySources]: Effect.fn(
        "j5.agents.agentPersonaRpc.getAgentPersonaLibrarySources",
      )(function* (_input: Input<"getAgentPersonaLibrarySources">) {
        const current = yield* library.sources().pipe(Effect.mapError(catalogError));
        const folders = yield* Effect.forEach(
          current.folders,
          (folder) =>
            (folder.exists ? agentPersonaFolderGitStatus(folder.path) : Effect.succeed(null)).pipe(
              Effect.map((git) => ({ ...folder, git })),
            ),
          { concurrency: 4 },
        );
        return { ...current, folders };
      }),
      [METHODS.getAgentHandoffs]: (input: Input<"getAgentHandoffs">) =>
        handoffs.list({ threadIds: input.threadIds }).pipe(
          Effect.map((list) => ({ handoffs: list })),
          Effect.mapError(catalogError),
        ),
      [METHODS.setAgentPersonaEnabled]: (input: Input<"setAgentPersonaEnabled">) =>
        library.setEnabled(input.personaId, input.enabled).pipe(Effect.mapError(catalogError)),
      [METHODS.setAgentPersonaLibraryFolders]: (input: Input<"setAgentPersonaLibraryFolders">) =>
        library.setFolders(input).pipe(Effect.mapError(catalogError)),
    };
  },
);
