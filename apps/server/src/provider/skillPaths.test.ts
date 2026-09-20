import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parseCodexSkillsListResponse } from "./Layers/CodexProvider.ts";
import { resolveProviderSkillPaths } from "./skillPaths.ts";

it.layer(NodeServices.layer)("provider skill paths", (it) => {
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
