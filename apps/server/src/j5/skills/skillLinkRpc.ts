import {
  AuthOrchestrationOperateScope,
  J5_SKILL_LINK_WS_METHODS as METHODS,
  SkillLinkError,
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
import { ServerConfig } from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { deriveProviderInstanceConfigMap } from "../../provider/Layers/ProviderInstanceRegistryHydration.ts";
import {
  normalizePath,
  skillDiscoveryState,
  skillOrigin,
  skillLinkUnavailableReason,
} from "@t3tools/shared/j5/skillInventory";
import { affectedSkillProviderIds, resolveSkillRoot } from "./skillRoots.ts";
import { refreshSkillProviders } from "./skillProviderRefresh.ts";
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
const failure = (cause: unknown) =>
  new SkillLinkError({ message: cause instanceof Error ? cause.message : String(cause) });
const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: failure });

export function skillLinkDiscovery(
  provider: ServerProvider | undefined,
  destinationPath: string,
  cwd?: string,
  sourcePath?: string,
): SkillLinkMutationResult["discovery"] {
  const state = skillDiscoveryState(provider, cwd);
  if (state !== "checked" || !provider) return state === "failed" ? "failed" : "not-checked";
  const workspace = cwd
    ? provider.workspaceSnapshots?.find((entry) => normalizePath(entry.cwd) === normalizePath(cwd))
    : undefined;
  const normalize = (value: string) => normalizePath(value).replace(/\/SKILL\.md$/, "");
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

function discoveryMessage(discovery: SkillLinkMutationResult["discovery"]) {
  switch (discovery) {
    case "detected":
      return "Detected by provider; this does not verify compatibility.";
    case "failed":
      return "Discovery refresh failed; the link remains created. Retry Refresh.";
    case "not-checked":
      return "Provider discovery has not checked this destination.";
    case "not-detected":
      return "Not detected by provider. Refresh or restart the provider session.";
  }
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
  const processRunner = yield* ProcessRunner.ProcessRunner.pipe(
    Effect.provide(ProcessRunner.layer),
  );
  const rootFor = (
    instance: ProviderInstanceConfig,
    scope: SkillLinkRequest["scope"],
    cwd?: string,
  ) =>
    resolveSkillRoot(instance, scope, cwd).pipe(
      Effect.mapError(failure),
      Effect.provideService(Path.Path, path),
    );
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
    const result = yield* attempt(() =>
      previewSkillLink(
        source.path,
        root,
        target.driver,
        request.scope === "project" ? cwd : undefined,
      ),
    );
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
    const affected = yield* affectedSkillProviderIds(
      snapshots,
      instances,
      [path.dirname(result.destinationPath)],
      { scope: request.scope, cwd },
    ).pipe(Effect.mapError(failure), Effect.provideService(Path.Path, path));
    const sharing = new Map(sharedWith.flat().map((entry) => [entry.instanceId, entry]));
    for (const id of affected)
      sharing.set(id, { instanceId: id, label: instances[id]?.displayName ?? id });
    let gitWarning: string | undefined;
    if (request.scope === "project" && cwd) {
      const checked = yield* processRunner
        .run({
          command: "git",
          args: ["check-ignore", "--quiet", "--", result.destinationPath],
          cwd,
          timeout: "5 seconds",
        })
        .pipe(Effect.option);
      gitWarning =
        checked._tag === "Some" && checked.value.code === 0
          ? undefined
          : "This project link is not confirmed ignored by Git. Committing it can expose an absolute path on this machine and will not share the skill files. Add the destination to .git/info/exclude before committing.";
    }
    return {
      ...result,
      sharedWith: [...sharing.values()],
      warnings: [
        ...result.warnings,
        ...(gitWarning ? [gitWarning] : []),
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
    scope: SkillLinkRequest["scope"],
    projectId?: ProjectId,
    sourcePath?: string,
  ): Effect.fn.Return<SkillLinkMutationResult["discovery"]> {
    return yield* Effect.gen(function* () {
      const snapshots = yield* providers.getProviders;
      const settings = yield* settingsService.getSettings;
      const cwd = yield* projectRoot(projectId);
      const affected = yield* affectedSkillProviderIds(
        snapshots,
        deriveProviderInstanceConfigMap(settings),
        [path.dirname(destination)],
        { scope, cwd },
      ).pipe(Effect.provideService(Path.Path, path));
      const updated = yield* refreshSkillProviders(
        providers,
        [...new Set([targetId, ...affected])],
        cwd,
      );
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
        Effect.uninterruptible(
          Effect.gen(function* () {
            const { checked, action } = yield* mutation(
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
                return { checked, action };
              }),
            );
            const discovery = yield* refresh(
              request.targetInstanceId,
              checked.destinationPath,
              request.scope,
              request.projectId,
              checked.sourcePath,
            );
            return {
              action,
              discovery,
              message: `${action === "created" ? "Link created" : "Link already exists"}. ${discoveryMessage(discovery)}`,
            };
          }),
        ),
      ),
    [METHODS.remove]: ({
      id,
      forget = false,
    }: {
      readonly id: string;
      readonly forget?: boolean | undefined;
    }) =>
      observe(
        METHODS.remove,
        Effect.uninterruptible(
          Effect.gen(function* () {
            const removed = yield* mutation(
              attempt(() =>
                removeManagedSkillLink(config.stateDir, id, platform === "win32", forget),
              ),
            );
            if (forget)
              return {
                action: "forgotten" as const,
                discovery: "not-checked" as const,
                message: "Record forgotten. The destination and source were left unchanged.",
              };
            const discovery = removed
              ? yield* refresh(
                  removed.targetInstanceId,
                  removed.destinationPath,
                  removed.scope,
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
