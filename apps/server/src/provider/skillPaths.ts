import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Resolve the whole file: either the directory or SKILL.md itself may be a link. */
export const resolveProviderSkillPaths = Effect.fn("resolveProviderSkillPaths")(function* (
  skills: ReadonlyArray<ServerProviderSkill>,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Effect.forEach(
    skills,
    (skill) =>
      Effect.gen(function* () {
        const { linkTarget: _previousTarget, ...source } = skill;
        const info = yield* fs.stat(skill.path).pipe(Effect.orElseSucceed(() => undefined));
        const file = info?.type === "Directory" ? path.join(skill.path, "SKILL.md") : skill.path;
        const linkTarget = yield* fs.realPath(file).pipe(Effect.orElseSucceed(() => undefined));
        return linkTarget ? { ...source, linkTarget } : source;
      }),
    { concurrency: 8 },
  );
});
