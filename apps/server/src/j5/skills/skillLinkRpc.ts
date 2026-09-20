import * as NodeOS from "node:os";
import {
  AuthOrchestrationOperateScope,
  ClaudeSettings,
  CodexSettings,
  J5_SKILL_LINK_WS_METHODS as METHODS,
  SkillLinkError,
  skillLinkUnavailableReason,
  skillOrigin,
  type ProjectId,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerProvider,
  type SkillLinkCreate,
  type SkillLinkMutationResult,
  type SkillLinkRequest,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../../config.ts";
import { resolveClaudeConfigDirPath } from "../../provider/Drivers/ClaudeSkills.ts";
import { deriveProviderInstanceConfigMap } from "../../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { ObserveRpcEffect } from "../agents/agentPersonaRpc.ts";
import { skillCatalogPermit } from "./skillCatalogTool.ts";
import {
  canonicalSkillRoot,
  createManagedSkillLink,
  listManagedSkillLinks,
  previewSkillLink,
  removeManagedSkillLink,
} from "./skillLinks.ts";

export const SKILL_LINK_RPC_SCOPES = {
  [METHODS.preview]: AuthOrchestrationOperateScope,
  [METHODS.create]: AuthOrchestrationOperateScope,
  [METHODS.list]: AuthOrchestrationOperateScope,
  [METHODS.remove]: AuthOrchestrationOperateScope,
} as const;
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);
const failure = (cause: unknown) =>
  new SkillLinkError({ message: cause instanceof Error ? cause.message : String(cause) });
const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: failure });

export const resolveSkillLinkRoot = Effect.fn("j5.skills.resolveLinkRoot")(function* (
  instance: ProviderInstanceConfig,
  scope: SkillLinkRequest["scope"],
  cwd?: string,
) {
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  if (instance.driver !== "codex" && instance.driver !== "claudeAgent")
    return yield* failure("Linking is supported only for Codex and Claude.");
  if (scope === "project") {
    if (!cwd) return yield* failure("Select an existing project for project scope.");
    return path.join(cwd, instance.driver === "codex" ? ".agents" : ".claude", "skills");
  }
  const environment = mergeProviderInstanceEnvironment(instance.environment);
  if (instance.driver === "codex") {
    yield* decodeCodexSettings(instance.config ?? {}).pipe(Effect.mapError(failure));
    // CODEX_HOME (including shadow homes) does not change the user .agents root.
    const home =
      (platform === "win32" ? environment.USERPROFILE : environment.HOME) || NodeOS.homedir();
    return path.resolve(cwd ?? process.cwd(), home, ".agents", "skills");
  }
  const config = yield* decodeClaudeSettings(instance.config ?? {}).pipe(Effect.mapError(failure));
  return path.join(yield* resolveClaudeConfigDirPath(config, environment, cwd), "skills");
});

export function skillLinkDiscovery(
  provider: ServerProvider | undefined,
  destinationPath: string,
  cwd?: string,
  sourcePath?: string,
): SkillLinkMutationResult["discovery"] {
  const workspace = cwd
    ? provider?.workspaceSnapshots?.find((entry) => entry.cwd === cwd)
    : undefined;
  if (provider?.status === "error" || workspace?.refreshError) return "failed";
  if (
    !provider?.enabled ||
    !provider.installed ||
    provider.availability === "unavailable" ||
    provider.status !== "ready" ||
    (cwd && !workspace)
  )
    return "not-checked";
  const normalize = (value: string) =>
    value
      .replaceAll("\\", "/")
      .replace(/\/SKILL\.md$/, "")
      .replace(/\/$/, "");
  return (workspace?.skills ?? provider.skills).some(
    (skill) =>
      normalize(skill.path) === normalize(destinationPath) ||
      (sourcePath !== undefined &&
        [skill.path, skill.linkTarget].some(
          (location) => location !== undefined && normalize(location) === normalize(sourcePath),
        )),
  )
    ? "detected"
    : "not-detected";
}

export const makeSkillLinkRpcHandlers = Effect.fn("j5.makeSkillLinkRpcHandlers")(function* (deps: {
  readonly observe: ObserveRpcEffect;
  readonly getProjectRoot: (
    projectId: ProjectId,
  ) => Effect.Effect<string | undefined, SkillLinkError>;
}) {
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettingsService;
  const providers = yield* ProviderRegistry;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const rootFor = (
    instance: ProviderInstanceConfig,
    scope: SkillLinkRequest["scope"],
    cwd?: string,
  ) => resolveSkillLinkRoot(instance, scope, cwd).pipe(Effect.provideService(Path.Path, path));
  const projectRoot = Effect.fn("j5.skills.linkProjectRoot")(function* (id?: ProjectId) {
    if (!id) return undefined;
    const cwd = yield* deps.getProjectRoot(id);
    if (!cwd) return yield* failure("The selected project no longer exists in this environment.");
    return cwd;
  });
  const preview = Effect.fn("j5.skills.previewLink")(function* (
    request: SkillLinkRequest,
    expectedSourcePath?: string,
  ) {
    const settings = yield* settingsService.getSettings.pipe(Effect.mapError(failure));
    const instances = deriveProviderInstanceConfigMap(settings);
    const snapshots = yield* providers.getProviders;
    const cwd = yield* projectRoot(request.projectId);
    const sourceProvider = snapshots.find(
      (entry) => entry.instanceId === request.source.instanceId,
    );
    const sourceSkills =
      (cwd
        ? sourceProvider?.workspaceSnapshots?.find((entry) => entry.cwd === cwd)?.skills
        : undefined) ?? sourceProvider?.skills;
    // Discovery may deduplicate the original location after adding a shared link.
    // Retries can use another current record for the same canonical source.
    const source = sourceSkills?.find(
      (skill) =>
        skill.name === request.source.name &&
        (skill.path === request.source.path ||
          (expectedSourcePath !== undefined &&
            skill.linkTarget === path.join(expectedSourcePath, "SKILL.md"))),
    );
    if (!source)
      return yield* failure(
        "The source skill is no longer in provider discovery. Refresh the inventory and try again.",
      );
    const reason = skillLinkUnavailableReason(
      skillOrigin(source, cwd, settings.skillCatalogSource),
    );
    if (reason) return yield* failure(reason);
    const target = instances[request.targetInstanceId];
    if (!target) return yield* failure("The destination provider instance no longer exists.");
    const root = yield* rootFor(target, request.scope, cwd);
    const result = yield* attempt(() => previewSkillLink(source.path, root, target.driver));
    const resolvedReason = skillLinkUnavailableReason(
      skillOrigin(
        { ...source, linkTarget: path.join(result.sourcePath, "SKILL.md") },
        cwd,
        settings.skillCatalogSource,
      ),
    );
    if (resolvedReason) return yield* failure(resolvedReason);
    const sharedWith = yield* Effect.forEach(
      Object.entries(instances),
      ([id, instance]) =>
        rootFor(instance, request.scope, cwd).pipe(
          Effect.flatMap((candidate) => attempt(() => canonicalSkillRoot(candidate))),
          Effect.map((candidate) =>
            candidate === path.dirname(result.destinationPath)
              ? [{ instanceId: id as ProviderInstanceId, label: instance.displayName ?? id }]
              : [],
          ),
          Effect.orElseSucceed(() => []),
        ),
      { concurrency: 4 },
    );
    return {
      ...result,
      sharedWith: sharedWith.flat(),
      warnings: [
        ...result.warnings,
        ...(target.driver === "codex" && request.scope === "user"
          ? [
              "Codex uses the user's .agents/skills directory, including instances with custom CODEX_HOME or shadow homes.",
            ]
          : []),
        "Edits to the source, scripts, references, and assets are shared. Running sessions may need refreshing or restarting. Discovery does not prove the skill works correctly.",
      ],
    };
  });
  const refresh = Effect.fn("j5.skills.refreshLinkedSkill")(function* (
    targetId: ProviderInstanceId,
    destination: string,
    projectId?: ProjectId,
    sourcePath?: string,
  ): Effect.fn.Return<SkillLinkMutationResult["discovery"]> {
    return yield* Effect.gen(function* () {
      const snapshots = yield* providers.getProviders;
      const results = yield* Effect.forEach(
        snapshots.filter(
          (entry) => entry.enabled && entry.installed && entry.availability !== "unavailable",
        ),
        (entry) =>
          providers.refreshInstance(entry.instanceId).pipe(
            Effect.as({ instanceId: entry.instanceId, failed: false }),
            Effect.catchCause(() => Effect.succeed({ instanceId: entry.instanceId, failed: true })),
          ),
        { concurrency: 2 },
      );
      if (results.some((entry) => entry.instanceId === targetId && entry.failed))
        return "failed" as const;
      const cwd = yield* projectRoot(projectId);
      let updated = yield* providers.getProviders;
      const target = updated.find((entry) => entry.instanceId === targetId);
      if (
        cwd &&
        target?.enabled &&
        target.installed &&
        !target.workspaceSnapshots?.some((entry) => entry.cwd === cwd)
      ) {
        updated = yield* providers.refreshWorkspaceSnapshot({ instanceId: targetId, cwd });
      }
      return skillLinkDiscovery(
        updated.find((entry) => entry.instanceId === targetId),
        destination,
        cwd,
        sourcePath,
      );
    }).pipe(Effect.catchCause(() => Effect.succeed("failed" as const)));
  });
  const observe = <A>(tag: string, effect: Effect.Effect<A, SkillLinkError>) =>
    deps.observe(tag, effect, { "rpc.aggregate": "j5SkillLinks" });
  // Share the catalog permit so a catalog apply cannot race a managed link operation.
  const mutation = <A>(effect: Effect.Effect<A, SkillLinkError>) =>
    skillCatalogPermit.withPermit(effect.pipe(Effect.uninterruptible));
  return {
    [METHODS.preview]: (request: SkillLinkRequest) => observe(METHODS.preview, preview(request)),
    [METHODS.list]: () =>
      observe(
        METHODS.list,
        attempt(() => listManagedSkillLinks(config.stateDir)),
      ),
    [METHODS.create]: (request: SkillLinkCreate) =>
      observe(
        METHODS.create,
        mutation(
          Effect.gen(function* () {
            const checked = yield* preview(request, request.expectedSourcePath);
            if (
              checked.sourcePath !== request.expectedSourcePath ||
              checked.destinationPath !== request.expectedDestinationPath
            )
              return yield* failure("Source or destination changed. Preview the link again.");
            const action = yield* attempt(() =>
              createManagedSkillLink(config.stateDir, checked, request, platform === "win32"),
            );
            const discovery = yield* refresh(
              request.targetInstanceId,
              checked.destinationPath,
              request.projectId,
              checked.sourcePath,
            );
            return {
              action,
              discovery,
              message: `${action === "created" ? "Link created" : "Link already exists"}. ${discovery === "detected" ? "Detected by provider; this does not verify compatibility." : discovery === "failed" ? "Discovery refresh failed; the link remains created. Retry Refresh." : discovery === "not-checked" ? "Provider discovery has not checked this destination." : "Not detected by provider. Refresh or restart the provider session."}`,
            };
          }),
        ),
      ),
    [METHODS.remove]: ({ id }: { readonly id: string }) =>
      observe(
        METHODS.remove,
        mutation(
          Effect.gen(function* () {
            const removed = yield* attempt(() =>
              removeManagedSkillLink(config.stateDir, id, platform === "win32"),
            );
            const discovery = removed
              ? yield* refresh(
                  removed.targetInstanceId,
                  removed.destinationPath,
                  removed.projectId,
                  removed.sourcePath,
                )
              : ("not-checked" as const);
            return {
              action: "removed" as const,
              discovery,
              message: `Link removed. The source is unchanged.${discovery === "failed" ? " Discovery refresh failed; retry Refresh." : " Running sessions may need refreshing or restarting."}`,
            };
          }),
        ),
      ),
  };
});
