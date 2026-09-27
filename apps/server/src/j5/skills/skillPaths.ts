import type { ServerProvider, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Resolve the whole file: either the directory or SKILL.md itself may be a link. */
export const resolveProviderSkillPaths = Effect.fn("resolveProviderSkillPaths")(function* (
  skills: ReadonlyArray<ServerProviderSkill>,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = [
    ...new Set(skills.filter((skill) => skill.scope !== "builtin").map((skill) => skill.path)),
  ];
  const resolved = yield* Effect.forEach(
    paths,
    (sourcePath) =>
      Effect.gen(function* () {
        const info = yield* fs.stat(sourcePath).pipe(Effect.orElseSucceed(() => undefined));
        const file = info?.type === "Directory" ? path.join(sourcePath, "SKILL.md") : sourcePath;
        return yield* fs.realPath(file).pipe(Effect.orElseSucceed(() => undefined));
      }),
    { concurrency: 8 },
  );
  const targets = new Map(paths.map((sourcePath, index) => [sourcePath, resolved[index]]));
  return skills.map((skill) => {
    if (skill.scope === "builtin") return skill;
    const { linkTarget: _previousTarget, ...source } = skill;
    const linkTarget = targets.get(source.path);
    return linkTarget ? { ...source, linkTarget } : source;
  });
});

/** Status emissions reuse skill arrays; explicit refresh invalidates path resolution. */
export const makeSkillPathResolver = Effect.fn("j5.skills.makePathResolver")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cache = new WeakMap<ServerProvider["skills"], ServerProvider["skills"]>();
  return {
    invalidate: (provider: ServerProvider) => Effect.sync(() => cache.delete(provider.skills)),
    resolve: Effect.fn("j5.skills.resolveSnapshotPaths")(function* (provider: ServerProvider) {
      let skills = cache.get(provider.skills);
      if (!skills) {
        skills = yield* resolveProviderSkillPaths(provider.skills).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
        cache.set(provider.skills, skills);
      }
      return { ...provider, skills };
    }),
  };
});
