import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parseCodexSkillsListResponse } from "../../provider/Layers/CodexProvider.ts";
import { resolveProviderSkillPaths } from "./skillPaths.ts";

it.layer(NodeServices.layer)("provider skill paths", (it) => {
  it.effect("leaves bundled skills at their executable path without resolving it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const skills = ["simplify", "loop"].map((name) => ({
        name,
        path: "/usr/bin/claude",
        scope: "builtin",
        enabled: true,
      }));
      const resolved = yield* resolveProviderSkillPaths(skills).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          stat: () => Effect.die("Bundled skills must not be statted"),
          realPath: () => Effect.die("Bundled skills must not be resolved"),
        }),
      );
      assert.deepStrictEqual(resolved, skills);
      assert.isTrue(resolved.every((skill) => skill.linkTarget === undefined));
    }),
  );
  it.effect(
    "bounds distinct path resolution to eight and retains order across out-of-order reads",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const skills = Array.from({ length: 17 }, (_, index) => ({
          name: `skill-${index}`,
          path: path.join(root, `skill-${index}.md`),
          enabled: true,
        }));
        for (const skill of skills) yield* fs.writeFileString(skill.path, "# Skill");
        const gates = yield* Effect.forEach(skills, () => Deferred.make<void>());
        const started = yield* Effect.forEach(skills, () => Deferred.make<void>());
        let active = 0;
        let peak = 0;
        const resolving = yield* resolveProviderSkillPaths(skills).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            realPath: (file) =>
              Effect.gen(function* () {
                const index = skills.findIndex((skill) => skill.path === file);
                peak = Math.max(peak, ++active);
                yield* Deferred.succeed(started[index]!, undefined);
                yield* Deferred.await(gates[index]!);
                const target = yield* fs.realPath(file);
                active--;
                return target;
              }),
          }),
          Effect.forkChild,
        );
        for (let offset = 0; offset < skills.length; offset += 8) {
          yield* Effect.forEach(started.slice(offset, offset + 8), (gate) => Deferred.await(gate));
          for (let index = Math.min(offset + 8, skills.length) - 1; index >= offset; index--)
            yield* Deferred.succeed(gates[index]!, undefined);
        }
        const resolved = yield* Fiber.join(resolving);
        assert.equal(peak, 8);
        assert.deepStrictEqual(
          resolved.map((skill) => skill.name),
          skills.map((skill) => skill.name),
        );
        for (const skill of resolved)
          assert.equal(skill.linkTarget, yield* fs.realPath(skill.path));
      }),
  );

  it.effect("rechecks the same input array after retargeting and drops failed resolutions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const source = path.join(root, "linked.md");
      const first = path.join(root, "first.md");
      const second = path.join(root, "second.md");
      yield* fs.writeFileString(first, "# First");
      yield* fs.writeFileString(second, "# Second");
      yield* fs.symlink(first, source);
      const input = [{ name: "skill", path: source, enabled: true, linkTarget: "/stale" }];
      assert.equal(
        (yield* resolveProviderSkillPaths(input))[0]!.linkTarget,
        yield* fs.realPath(first),
      );
      yield* fs.remove(source);
      yield* fs.symlink(second, source);
      assert.equal(
        (yield* resolveProviderSkillPaths(input))[0]!.linkTarget,
        yield* fs.realPath(second),
      );
      yield* fs.remove(second);
      assert.deepStrictEqual(yield* resolveProviderSkillPaths(input), [
        { name: "skill", path: source, enabled: true },
      ]);
    }),
  );
  it.effect("resolves each distinct path once and preserves ordered provider metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const file = path.join(root, "SKILL.md");
      yield* fs.writeFileString(file, "# Shared");
      const calls = { stat: 0, realPath: 0 };
      const skills = Array.from({ length: 32 }, (_, index) => ({
        name: `skill-${index}`,
        path: file,
        enabled: index % 2 === 0,
        pluginId: `plugin-${index}`,
        linkTarget: "/stale",
      }));
      const result = yield* resolveProviderSkillPaths(skills).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          stat: (file) => {
            calls.stat++;
            return fs.stat(file);
          },
          realPath: (file) => {
            calls.realPath++;
            return fs.realPath(file);
          },
        }),
      );
      const canonical = yield* fs.realPath(file);
      assert.deepStrictEqual(
        result,
        skills.map((skill) => ({ ...skill, linkTarget: canonical })),
      );
      assert.deepStrictEqual(calls, { stat: 1, realPath: 1 });
    }),
  );
  it.effect(
    "preserves Codex plugin identity and resolves file and directory links, including already resolved paths",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const directory = path.join(root, "original");
        yield* fs.makeDirectory(directory);
        const file = path.join(directory, "SKILL.md");
        yield* fs.writeFileString(file, "# Review");
        const resolved = yield* fs.realPath(file);
        const directoryLink = path.join(root, "linked-directory");
        const fileLink = path.join(root, "linked-file.md");
        yield* fs.symlink(directory, directoryLink);
        yield* fs.symlink(file, fileLink);
        const paths = [
          file,
          resolved,
          path.join(directoryLink, "SKILL.md"),
          fileLink,
          directoryLink,
          path.join(root, "missing"),
        ];
        const mapped = parseCodexSkillsListResponse(
          {
            data: [
              {
                cwd: root,
                errors: [],
                skills: paths.map((path, index) => ({
                  name: `review-${index}`,
                  path,
                  enabled: index !== 0,
                  description: "Review changes",
                  scope: "user",
                  pluginId: "review@tools",
                })),
              },
            ],
          },
          root,
        );
        const skills = yield* resolveProviderSkillPaths(mapped);
        assert.deepStrictEqual(
          skills.map((skill) => skill.linkTarget),
          [resolved, resolved, resolved, resolved, resolved, undefined],
        );
        assert.deepStrictEqual(
          skills.map((skill) => skill.path),
          paths,
        );
        assert.isTrue(skills.every((skill) => skill.pluginId === "review@tools"));
        assert.isFalse(skills[0]!.enabled);
        const ordinary = parseCodexSkillsListResponse(
          {
            data: [
              {
                cwd: root,
                errors: [],
                skills: [
                  {
                    name: "plain",
                    path: file,
                    scope: "user",
                    enabled: true,
                    description: "",
                    pluginId: null,
                  },
                ],
              },
            ],
          },
          root,
        );
        assert.isUndefined(ordinary[0]!.pluginId);
      }),
  );
});
