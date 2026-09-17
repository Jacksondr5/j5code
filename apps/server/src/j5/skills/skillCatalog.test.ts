// @effect-diagnostics nodeBuiltinImport:off - Exercises real symlinks in temporary directories.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { stringify } from "yaml";

import { createSkillCatalog } from "./skillCatalog.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});

const groups = {
  core: { description: "General guidance", skills: ["explain"] },
  dynatrace: { description: "Queries", skills: ["dql"] },
  logs: { description: "Logs", skills: ["logs"], depends: ["dynatrace"] },
  frontends: { description: "RUM", skills: ["frontends"], depends: ["logs"] },
};

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "skill-catalog-test-"));
  temporary.push(root);
  const folder = NodePath.join(root, "catalog");
  const homeDirectory = NodePath.join(root, "home");
  for (const name of Object.values(groups).flatMap((group) => group.skills)) {
    const path = NodePath.join(folder, "skills", name);
    await NodeFSP.mkdir(path, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(path, "SKILL.md"),
      `---\nname: ${name}\ndescription: Fixture skill\n---\n`,
    );
  }
  await NodeFSP.writeFile(NodePath.join(folder, "catalog.yaml"), stringify({ groups }));
  const claudeConfigDirectory = NodePath.join(homeDirectory, ".claude");
  return {
    root,
    folder,
    homeDirectory,
    targets: [
      NodePath.join(claudeConfigDirectory, "skills"),
      NodePath.join(homeDirectory, ".agents", "skills"),
    ],
    service: createSkillCatalog({
      homeDirectory,
      claudeConfigDirectory,
      platform: HostProcessPlatform.defaultValue(),
    }),
  };
}

describe("user skill catalog", () => {
  it("installs multiple groups and transitive requirements, persists selection, and reuses existing links", async () => {
    const { folder, service, targets } = await fixture();
    expect((await service.read()).folder).toBeNull();
    expect((await service.read(folder)).selectedGroups).toEqual([]);
    await service.apply({ folder, groups: ["frontends", "core"] });
    const first = await NodeFSP.lstat(NodePath.join(targets[0]!, "explain"));
    for (const target of targets) {
      expect((await NodeFSP.readdir(target)).sort()).toEqual([
        "dql",
        "explain",
        "frontends",
        "logs",
      ]);
      expect(await NodeFSP.realpath(NodePath.join(target, "logs"))).toBe(
        await NodeFSP.realpath(NodePath.join(folder, "skills", "logs")),
      );
    }
    await service.apply({ folder, groups: ["core", "frontends"] });
    expect((await NodeFSP.lstat(NodePath.join(targets[0]!, "explain"))).ino).toBe(first.ino);
    expect((await service.read()).selectedGroups).toEqual(["core", "frontends"]);
  });

  it("deselects only owned links, preserving unrelated directories and broken links", async () => {
    const { folder, service, targets, root } = await fixture();
    await service.apply({ folder, groups: ["core", "logs"] });
    await NodeFSP.mkdir(NodePath.join(targets[0]!, "personal"));
    await NodeFSP.symlink(
      NodePath.join(root, "missing-foreign-skill"),
      NodePath.join(targets[0]!, "foreign"),
      "dir",
    );
    await service.apply({ folder, groups: [] });
    expect((await NodeFSP.readdir(targets[0]!)).sort()).toEqual(["foreign", "personal"]);
    expect(await NodeFSP.readdir(targets[1]!)).toEqual([]);
    expect((await service.read()).selectedGroups).toEqual([]);
  });

  it("removes a dangling owned link after an upstream skill rename", async () => {
    const { folder, service, targets } = await fixture();
    await service.apply({ folder, groups: ["core"] });
    await NodeFSP.rename(
      NodePath.join(folder, "skills", "explain"),
      NodePath.join(folder, "skills", "explain-new"),
    );
    await NodeFSP.writeFile(
      NodePath.join(folder, "catalog.yaml"),
      stringify({
        groups: { ...groups, core: { description: "Renamed", skills: ["explain-new"] } },
      }),
    );
    await service.apply({ folder, groups: ["core"] });
    for (const target of targets) expect(await NodeFSP.readdir(target)).toEqual(["explain-new"]);
  });

  it.each(["directory", "symlink"])(
    "rejects a foreign %s collision before changing existing links or selection",
    async (kind) => {
      const { folder, service, targets, root } = await fixture();
      await service.apply({ folder, groups: ["core"] });
      const collision = NodePath.join(targets[1]!, "logs");
      if (kind === "directory") await NodeFSP.mkdir(collision);
      else await NodeFSP.symlink(NodePath.join(root, "foreign-missing"), collision, "dir");
      await expect(service.apply({ folder, groups: ["logs"] })).rejects.toThrow("name conflicts");
      expect(await NodeFSP.readdir(targets[0]!)).toEqual(["explain"]);
      expect((await NodeFSP.lstat(collision)).isSymbolicLink()).toBe(kind === "symlink");
      expect((await service.read()).selectedGroups).toEqual(["core"]);
    },
  );

  it("rejects invalid catalog dependencies, duplicate membership, and unsafe names", async () => {
    const { folder, service, targets } = await fixture();
    await service.apply({ folder, groups: ["core"] });
    for (const invalid of [
      { ...groups, core: { ...groups.core, depends: ["absent"] } },
      {
        ...groups,
        core: { ...groups.core, depends: ["logs"] },
        dynatrace: { ...groups.dynatrace, depends: ["core"] },
      },
      { ...groups, another: { description: "Duplicate", skills: ["explain"] } },
      { ...groups, another: { description: "Unsafe", skills: ["../outside"] } },
    ]) {
      await NodeFSP.writeFile(
        NodePath.join(folder, "catalog.yaml"),
        stringify({ groups: invalid }),
      );
      await expect(service.apply({ folder, groups: ["logs"] })).rejects.toThrow();
      expect(await NodeFSP.readdir(targets[0]!)).toEqual(["explain"]);
    }
  });

  it("rejects unknown selections and missing skill files before applying", async () => {
    const { folder, service, targets } = await fixture();
    await service.apply({ folder, groups: ["core"] });
    await expect(service.apply({ folder, groups: ["absent"] })).rejects.toThrow(
      "Unknown skill group",
    );
    await NodeFSP.rm(NodePath.join(folder, "skills", "logs", "SKILL.md"));
    await expect(service.apply({ folder, groups: ["logs"] })).rejects.toThrow();
    expect(await NodeFSP.readdir(targets[0]!)).toEqual(["explain"]);
  });

  it("moves owned links when changing catalog folders", async () => {
    const { folder, service, targets, root } = await fixture();
    await service.apply({ folder, groups: ["core", "logs"] });
    const next = NodePath.join(root, "other-catalog");
    await NodeFSP.cp(folder, next, { recursive: true });
    expect((await service.read(next)).selectedGroups).toEqual([]);
    await service.apply({ folder: next, groups: ["core"] });
    for (const target of targets) {
      expect(await NodeFSP.readdir(target)).toEqual(["explain"]);
      expect(await NodeFSP.realpath(NodePath.join(target, "explain"))).toBe(
        await NodeFSP.realpath(NodePath.join(next, "skills", "explain")),
      );
    }
  });

  it("handles user skill roots that point to the same directory", async () => {
    const { folder, service, targets } = await fixture();
    await NodeFSP.mkdir(targets[1]!, { recursive: true });
    await NodeFSP.mkdir(NodePath.join(targets[0]!, ".."), { recursive: true });
    await NodeFSP.symlink(targets[1]!, targets[0]!, "dir");
    await service.apply({ folder, groups: ["core"] });
    expect(await NodeFSP.readdir(targets[1]!)).toEqual(["explain"]);
  });
});
