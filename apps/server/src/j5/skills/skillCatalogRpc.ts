import * as NodeOS from "node:os";

import {
  AuthOrchestrationOperateScope,
  J5_SKILL_CATALOG_WS_METHODS,
  SkillCatalogError,
  type J5SkillCatalogRpcSchemas,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ServerConfig } from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import type { ObserveRpcEffect } from "../agents/agentPersonaRpc.ts";
import { createSkillCatalogTool } from "./skillCatalogTool.ts";

const METHODS = J5_SKILL_CATALOG_WS_METHODS;

/** Spread into `RPC_REQUIRED_SCOPES`; the upstream `satisfies` check still covers every tag. */
export const SKILL_CATALOG_RPC_SCOPES = {
  [METHODS.getSkillCatalogStatus]: AuthOrchestrationOperateScope,
  [METHODS.applySkillCatalogGroups]: AuthOrchestrationOperateScope,
  [METHODS.updateSkillCatalog]: AuthOrchestrationOperateScope,
} as const;

type Input<K extends keyof typeof J5SkillCatalogRpcSchemas> =
  (typeof J5SkillCatalogRpcSchemas)[K]["input"]["Type"];

const TRACE = { "rpc.aggregate": "j5SkillCatalog" } as const;

/** Handlers for `J5SkillCatalogRpcGroup`; spread once into the upstream handler object. */
export const makeSkillCatalogRpcHandlers = Effect.fn("j5.makeSkillCatalogRpcHandlers")(
  function* (deps: { readonly observe: ObserveRpcEffect; readonly homeDir?: string }) {
    const config = yield* ServerConfig;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const providers = yield* ProviderRegistry;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Provide the shared process runner here so the WebSocket layer gains no
    // new service requirement; only platform services stay in context.
    const processRunner = yield* ProcessRunner.ProcessRunner.pipe(
      Effect.provide(ProcessRunner.layer),
    );
    const tool = createSkillCatalogTool({
      stateDir: config.stateDir,
      homeDir: deps.homeDir ?? NodeOS.homedir(),
      fs,
      path,
      processRunner,
    });
    const { observe } = deps;
    const refreshSkills = providers.getProviders.pipe(
      Effect.flatMap((snapshots) =>
        Effect.forEach(
          snapshots.filter((provider) => provider.enabled),
          (provider) => providers.refreshInstance(provider.instanceId),
          { concurrency: 2, discard: true },
        ),
      ),
      Effect.ignoreCause({ log: true }),
    );

    // Transport context, not a skill-management concept: reject a stale page's
    // request before invoking the tool, then run against the captured source
    // even if settings change mid-operation.
    const matchingSource = Effect.fn("j5.skillCatalog.matchingSource")(function* (
      expectedSource: string,
    ): Effect.fn.Return<string, SkillCatalogError> {
      const configured = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new SkillCatalogError({ message: `Could not read server settings: ${String(cause)}` }),
        ),
      );
      if (expectedSource !== configured.skillCatalogSource) {
        return yield* new SkillCatalogError({
          message: "Skill catalog source changed. Reload Settings → Skills and retry.",
        });
      }
      return configured.skillCatalogSource;
    });

    return {
      [METHODS.getSkillCatalogStatus]: (input: Input<"getSkillCatalogStatus">) =>
        observe(
          METHODS.getSkillCatalogStatus,
          Effect.gen(function* () {
            const source = yield* matchingSource(input.expectedSource);
            return yield* tool.status({ source });
          }),
          TRACE,
        ),
      [METHODS.applySkillCatalogGroups]: (input: Input<"applySkillCatalogGroups">) =>
        observe(
          METHODS.applySkillCatalogGroups,
          Effect.gen(function* () {
            const source = yield* matchingSource(input.expectedSource);
            // Partial failures can still change links. Preserve the apply result
            // while publishing fresh discovery to every connected client.
            return yield* tool
              .apply({ source, groups: [...input.groups] })
              .pipe(Effect.ensuring(refreshSkills));
          }),
          TRACE,
        ),
      [METHODS.updateSkillCatalog]: (input: Input<"updateSkillCatalog">) =>
        observe(
          METHODS.updateSkillCatalog,
          Effect.gen(function* () {
            const source = yield* matchingSource(input.expectedSource);
            return yield* tool.update({ source }).pipe(Effect.ensuring(refreshSkills));
          }),
          TRACE,
        ),
    };
  },
);
