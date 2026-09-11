import {
  AgentPersonaCatalogError,
  AgentPersonaImportConflictError,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  J5_AGENT_PERSONA_WS_METHODS,
  type EnvironmentAuthorizationError,
  type J5AgentPersonaRpcSchemas,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { stringify as toYaml } from "yaml";

import { definitionDigest, makeAgentPersonaLibrary } from "./agentPersonaLibrary.ts";
import { agentPersonaFolderGitStatus } from "./agentPersonaLibraryGit.ts";
import { buildAgentPersonaCatalog } from "./agentPersonaRouting.ts";
import { agentPersonaUsage } from "./agentPersonaUsage.ts";

const METHODS = J5_AGENT_PERSONA_WS_METHODS;

/** Spread into `RPC_REQUIRED_SCOPES`; the upstream `satisfies` check still covers every tag. */
export const AGENT_PERSONA_RPC_SCOPES = {
  [METHODS.getAgentPersonaCatalog]: AuthOrchestrationReadScope,
  [METHODS.importAgentPersonas]: AuthOrchestrationOperateScope,
  [METHODS.editImportedAgentPersona]: AuthOrchestrationOperateScope,
  [METHODS.setImportedAgentPersonaEnabled]: AuthOrchestrationOperateScope,
  [METHODS.removeImportedAgentPersona]: AuthOrchestrationOperateScope,
  [METHODS.removeSourceAgentPersona]: AuthOrchestrationOperateScope,
  [METHODS.removeAgentPersona]: AuthOrchestrationOperateScope,
  [METHODS.restoreSourceAgentPersona]: AuthOrchestrationOperateScope,
  [METHODS.createAgentPersona]: AuthOrchestrationOperateScope,
  [METHODS.readAgentPersona]: AuthOrchestrationReadScope,
  [METHODS.getAgentPersonaUsage]: AuthOrchestrationReadScope,
  [METHODS.getAgentPersonaLibrarySources]: AuthOrchestrationReadScope,
  [METHODS.setAgentPersonaLibraryFolders]: AuthOrchestrationOperateScope,
} as const;

/** Matches the per-session `observeRpcEffect` closure in ws.ts (instrumentation plus scope check). */
export type ObserveRpcEffect = <A, E, R>(
  method: string,
  effect: Effect.Effect<A, E, R>,
  traceAttributes?: Readonly<Record<string, unknown>>,
) => Effect.Effect<A, E | EnvironmentAuthorizationError, R>;

type Input<K extends keyof typeof J5AgentPersonaRpcSchemas> =
  (typeof J5AgentPersonaRpcSchemas)[K]["input"]["Type"];

const isImportConflict = Schema.is(AgentPersonaImportConflictError);
const catalogError = (cause: unknown) => new AgentPersonaCatalogError({ message: String(cause) });
const TRACE = { "rpc.aggregate": "j5AgentPersonas" } as const;

/** Handlers for `J5AgentPersonaRpcGroup`; spread once into the upstream handler object. */
export const makeAgentPersonaRpcHandlers = Effect.fn("j5.makeAgentPersonaRpcHandlers")(
  function* (deps: {
    readonly providers: Effect.Effect<ReadonlyArray<ServerProvider>>;
    readonly observe: ObserveRpcEffect;
  }) {
    const library = yield* makeAgentPersonaLibrary;
    const { observe } = deps;
    // Usage reads the projections through the session's SqlClient, captured once here.
    const sql = yield* SqlClient.SqlClient;
    const usage = () => agentPersonaUsage().pipe(Effect.provideService(SqlClient.SqlClient, sql));
    return {
      [METHODS.getAgentPersonaCatalog]: (_input: Input<"getAgentPersonaCatalog">) =>
        observe(
          METHODS.getAgentPersonaCatalog,
          Effect.gen(function* () {
            const current = yield* library.catalog().pipe(Effect.mapError(catalogError));
            const catalog = buildAgentPersonaCatalog(yield* deps.providers, current.definitions);
            const importedIds = new Set(current.importedIds);
            const digests = new Map(
              [...current.definitions, ...current.removedSources].map((definition) => [
                definition.id,
                definitionDigest(definition),
              ]),
            );
            const editable = new Map(
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
            const removed = buildAgentPersonaCatalog(yield* deps.providers, current.removedSources);
            return {
              personas: [
                ...catalog.personas.map((persona) => ({
                  ...persona,
                  imported: importedIds.has(persona.personaId),
                  origin: origin(persona.personaId),
                  definitionDigest: digests.get(persona.personaId)!,
                  ...(editable.has(persona.personaId)
                    ? { editable: editable.get(persona.personaId)! }
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
            };
          }),
          TRACE,
        ),
      [METHODS.importAgentPersonas]: (input: Input<"importAgentPersonas">) =>
        observe(
          METHODS.importAgentPersonas,
          library
            .importFiles(input)
            .pipe(
              Effect.mapError((cause) => (isImportConflict(cause) ? cause : catalogError(cause))),
            ),
          TRACE,
        ),
      [METHODS.editImportedAgentPersona]: (input: Input<"editImportedAgentPersona">) =>
        observe(
          METHODS.editImportedAgentPersona,
          library.editImported(input).pipe(Effect.mapError(catalogError)),
          TRACE,
        ),
      [METHODS.setImportedAgentPersonaEnabled]: (input: Input<"setImportedAgentPersonaEnabled">) =>
        observe(
          METHODS.setImportedAgentPersonaEnabled,
          library
            .setImportedEnabled(input.personaId, input.enabled)
            .pipe(Effect.mapError(catalogError)),
          TRACE,
        ),
      [METHODS.removeImportedAgentPersona]: (input: Input<"removeImportedAgentPersona">) =>
        observe(
          METHODS.removeImportedAgentPersona,
          library.removeImported(input.personaId).pipe(Effect.mapError(catalogError)),
          TRACE,
        ),
      [METHODS.removeSourceAgentPersona]: (input: Input<"removeSourceAgentPersona">) =>
        observe(
          METHODS.removeSourceAgentPersona,
          library.removeSource(input.personaId).pipe(Effect.mapError(catalogError)),
          TRACE,
        ),
      [METHODS.removeAgentPersona]: (input: Input<"removeAgentPersona">) =>
        observe(
          METHODS.removeAgentPersona,
          library.removeAgent(input.personaId).pipe(Effect.mapError(catalogError)),
          TRACE,
        ),
      [METHODS.restoreSourceAgentPersona]: (input: Input<"restoreSourceAgentPersona">) =>
        observe(
          METHODS.restoreSourceAgentPersona,
          library.restoreSource(input.personaId).pipe(Effect.mapError(catalogError)),
          TRACE,
        ),
      [METHODS.createAgentPersona]: (input: Input<"createAgentPersona">) =>
        observe(
          METHODS.createAgentPersona,
          library.createPersona(input).pipe(Effect.mapError(catalogError)),
          TRACE,
        ),
      [METHODS.readAgentPersona]: (input: Input<"readAgentPersona">) =>
        observe(
          METHODS.readAgentPersona,
          library.read(input.personaId).pipe(
            Effect.map((definition) => ({
              definition,
              fileName: `${definition.id}.yaml`,
              // Block scalars keep multiline instructions readable; the import parser accepts the result.
              yaml: toYaml(definition, { lineWidth: 0 }),
            })),
            Effect.mapError(catalogError),
          ),
          TRACE,
        ),
      [METHODS.getAgentPersonaUsage]: (_input: Input<"getAgentPersonaUsage">) =>
        observe(METHODS.getAgentPersonaUsage, usage().pipe(Effect.mapError(catalogError)), TRACE),
      [METHODS.getAgentPersonaLibrarySources]: (_input: Input<"getAgentPersonaLibrarySources">) =>
        observe(
          METHODS.getAgentPersonaLibrarySources,
          Effect.gen(function* () {
            const current = yield* library.sources().pipe(Effect.mapError(catalogError));
            const folders = yield* Effect.forEach(
              current.folders,
              (folder) =>
                (folder.exists
                  ? agentPersonaFolderGitStatus(folder.path)
                  : Effect.succeed(null)
                ).pipe(Effect.map((git) => ({ ...folder, git }))),
              { concurrency: 4 },
            );
            return { ...current, folders };
          }),
          TRACE,
        ),
      [METHODS.setAgentPersonaLibraryFolders]: (input: Input<"setAgentPersonaLibraryFolders">) =>
        observe(
          METHODS.setAgentPersonaLibraryFolders,
          library.setFolders(input).pipe(Effect.mapError(catalogError)),
          TRACE,
        ),
    };
  },
);
