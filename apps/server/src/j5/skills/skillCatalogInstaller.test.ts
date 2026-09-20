// @effect-diagnostics nodeBuiltinImport:off - exercises the native async installer with isolated filesystem fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { stringify } from "yaml";

import {
  applyPlan,
  IncompleteApplyError,
  loadCatalog,
  loadState,
  planInstall,
  resolveSelection,
  runApply,
  saveState,
  skillDescription,
  stateFilePath,
  targetDirs,
  verifyLinks,
  type Catalog,
} from "./skillCatalogInstaller.ts";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof NodeFSP>()) }));
const windows = HostProcessPlatform.defaultValue() === "win32";
const linkType = windows ? "junction" : "dir";
let root: string;
let homeDir: string;
let catalogDir: string;
const core = { core: { description: "Core", skills: ["explain"] } };

async function writeCatalog(dir = catalogDir, groups: Catalog["groups"] = core) {
  await NodeFSP.mkdir(dir, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(dir, "catalog.yaml"), stringify({ groups }));
  for (const skill of Object.values(groups).flatMap((group) => group.skills)) {
    await NodeFSP.mkdir(NodePath.join(dir, "skills", skill), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(dir, "skills", skill, "SKILL.md"),
      `---\ndescription: Explain clearly\n---\n`,
    );
  }
  return loadCatalog(NodePath.join(dir, "catalog.yaml"));
}
const dirs = () => targetDirs(homeDir, process.env, catalogDir);
async function apply(
  selected: string[],
  dir = catalogDir,
  options?: Parameters<typeof runApply>[1],
) {
  return runApply(
    {
      catalog: await loadCatalog(NodePath.join(dir, "catalog.yaml")),
      catalogDir: dir,
      homeDir,
      state: await loadState(homeDir),
      selected,
      windows,
    },
    options,
  );
}

beforeEach(async () => {
  root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j5-installer-"));
  homeDir = NodePath.join(root, "home");
  catalogDir = NodePath.join(root, "catalog");
  vi.stubEnv("CLAUDE_CONFIG_DIR", "");
  await writeCatalog();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await NodeFSP.rm(root, { recursive: true, force: true });
});

describe("catalog validation and selection", () => {
  it.each([
    [{}, 'expected a "groups" map'],
    [{ groups: [] }, 'expected a "groups" map'],
    [{ groups: { Core: core.core } }, "Invalid group name: Core"],
    [{ groups: { core: null } }, "expected an object"],
    [{ groups: { core: { skills: ["explain"] } } }, "missing description"],
    [{ groups: { core: { description: "c", skills: [] } } }, "nonempty skills list"],
    [{ groups: { core: { description: "c", skills: ["../escape"] } } }, "invalid skill name"],
    [{ groups: { core: { ...core.core, depends: "other" } } }, "depends must be a list"],
    [{ groups: { core: { ...core.core, depends: ["other"] } } }, "unknown dependency: other"],
    [
      { groups: { core: { ...core.core, depends: ["constructor"] } } },
      "unknown dependency: constructor",
    ],
    [{ groups: { ...core, other: core.core } }, "Skill explain is in groups core and other"],
  ])("rejects invalid catalog %#", async (data, message) => {
    const file = NodePath.join(catalogDir, "catalog.yaml");
    await NodeFSP.writeFile(file, stringify(data));
    await expect(loadCatalog(file)).rejects.toThrow(message);
  });

  it("expands dependencies, keeps explicit selections, and rejects cycles and unknown groups", async () => {
    const catalog = await writeCatalog(catalogDir, {
      ...core,
      review: { description: "Review", skills: ["review"], depends: ["core"] },
      all: { description: "All", skills: ["all"], depends: ["review"] },
    });
    expect(resolveSelection(catalog, ["all", "all"])).toEqual({
      groups: ["core", "review", "all"],
      skills: ["explain", "review", "all"],
    });
    for (const group of ["unknown", "constructor"]) {
      expect(() => resolveSelection(catalog, [group])).toThrow(`Unknown group: ${group}`);
    }
    expect((await apply(["all", "all"])).selectedGroups).toEqual(["all"]);
    expect((await loadState(homeDir)).groups).toEqual(["all"]);
    const cyclic = await writeCatalog(catalogDir, {
      core: { ...core.core, depends: ["other"] },
      other: { description: "o", skills: ["other"], depends: ["core"] },
    });
    expect(() => resolveSelection(cyclic, ["core"])).toThrow(
      "Dependency cycle: core -> other -> core",
    );
  });

  it("rejects missing SKILL.md before changing links or state", async () => {
    await NodeFSP.unlink(NodePath.join(catalogDir, "skills", "explain", "SKILL.md"));
    await expect(apply(["core"])).rejects.toThrow("Missing SKILL.md for: explain");
    await expect(NodeFSP.lstat(homeDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("link ownership", () => {
  it("classifies absent, unchanged, replacement, and foreign entries without mutation", async () => {
    const skills = ["absent", "same", "owned", "foreign", "directory", "file"];
    await writeCatalog(catalogDir, { core: { description: "c", skills } });
    const dir = dirs()[0]!;
    await NodeFSP.mkdir(dir, { recursive: true });
    const target = (skill: string) => NodePath.join(catalogDir, "skills", skill);
    const path = (skill: string) => NodePath.join(dir, skill);
    await NodeFSP.symlink(target("same"), path("same"), linkType);
    await NodeFSP.symlink(target("same"), path("owned"), linkType);
    await NodeFSP.symlink(target("same"), path("foreign"), linkType);
    await NodeFSP.mkdir(path("directory"));
    await NodeFSP.writeFile(path("file"), "keep");
    const before = await NodeFSP.readdir(dir);
    const plan = await planInstall({
      catalogDir,
      skills,
      dirs: [dir],
      recordedLinks: [{ path: path("owned"), target: target("same") }],
    });
    expect(plan.additions.map((entry) => [entry.skill, entry.replace ?? false])).toEqual([
      ["absent", false],
      ["owned", true],
    ]);
    expect(plan.unchanged.map((entry) => entry.skill)).toEqual(["same"]);
    expect(plan.conflicts.map((entry) => entry.skill)).toEqual(["foreign", "directory", "file"]);
    expect(await NodeFSP.readdir(dir)).toEqual(before);
    expect(await NodeFSP.readFile(path("file"), "utf8")).toBe("keep");
    expect(
      await verifyLinks([{ skill: "owned", linkPath: path("owned"), target: target("same") }]),
    ).toEqual([]);
  });

  it("installs idempotently, replaces owned targets, and deselects only owned links", async () => {
    expect(await apply(["core"])).toMatchObject({ installed: 2, removed: 0 });
    expect(await apply(["core"])).toMatchObject({ installed: 0, unchanged: 2 });
    const otherCatalog = NodePath.join(root, "other-catalog");
    await writeCatalog(otherCatalog);
    expect(await apply(["core"], otherCatalog)).toMatchObject({ installed: 2, removed: 0 });
    const links = (await loadState(homeDir)).links;
    expect(
      links.every((link) => link.target === NodePath.join(otherCatalog, "skills", "explain")),
    ).toBe(true);
    for (const dir of dirs()) await NodeFSP.writeFile(NodePath.join(dir, "foreign"), "keep");
    expect(await apply([], otherCatalog)).toMatchObject({ removed: 2 });
    expect((await loadState(homeDir)).links).toEqual([]);
    for (const dir of dirs()) expect(await NodeFSP.readdir(dir)).toEqual(["foreign"]);
  });

  it("removes broken owned links and their state after upstream deletion", async () => {
    await apply(["core"]);
    await NodeFSP.rm(NodePath.join(catalogDir, "skills", "explain"), { recursive: true });
    expect(await apply([])).toMatchObject({ removed: 2 });
    expect((await loadState(homeDir)).links).toEqual([]);
    for (const dir of dirs()) expect(await NodeFSP.readdir(dir)).toEqual([]);
  });

  it("rechecks additions and removals and stops at the first changed entry", async () => {
    const [dir] = dirs();
    const plan = await planInstall({
      catalogDir,
      skills: ["explain"],
      dirs: [dir!],
      recordedLinks: [],
    });
    await NodeFSP.mkdir(NodePath.join(dir!, "explain"), { recursive: true });
    const addition = await applyPlan(plan, { windows });
    expect(addition.failed[0]?.error).toContain("changed since inspection");
    expect(addition.applied).toEqual([]);
    await NodeFSP.rm(dir!, { recursive: true });
    await apply(["core"]);
    const removal = await planInstall({
      catalogDir,
      skills: [],
      dirs: dirs(),
      recordedLinks: (await loadState(homeDir)).links,
    });
    await NodeFSP.unlink(NodePath.join(dir!, "explain"));
    await NodeFSP.writeFile(NodePath.join(dir!, "explain"), "foreign");
    const result = await applyPlan(removal, { windows });
    expect(result.failed[0]?.error).toContain("changed since inspection");
    expect(result.applied).toEqual([]);
    expect(await NodeFSP.readFile(NodePath.join(dir!, "explain"), "utf8")).toBe("foreign");
    expect((await NodeFSP.lstat(NodePath.join(dirs()[1]!, "explain"))).isSymbolicLink()).toBe(true);
  });
});

describe("partial apply recovery", () => {
  it.each(["remove", "create"])(
    "retains correct ownership after a replacement %s fails",
    async (failure) => {
      await apply(["core"]);
      const otherCatalog = NodePath.join(root, "other-catalog");
      await writeCatalog(otherCatalog);
      const blocked = NodePath.join(dirs()[1]!, "explain");
      const originalUnlink = NodeFSP.unlink;
      const originalSymlink = NodeFSP.symlink;
      if (failure === "remove") {
        vi.spyOn(NodeFSP, "unlink").mockImplementation(async (path) => {
          if (path === blocked) throw new Error("blocked removal");
          return originalUnlink(path);
        });
      } else {
        vi.spyOn(NodeFSP, "symlink").mockImplementation(async (target, path, type) => {
          if (path === blocked) throw new Error("blocked creation");
          return originalSymlink(target, path, type);
        });
      }
      const error = await apply(["core"], otherCatalog).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(IncompleteApplyError);
      if (!(error instanceof IncompleteApplyError)) throw new Error("Expected partial result");
      expect(error.result).toMatchObject({
        installed: 1,
        removed: failure === "create" ? 1 : 0,
        failed: [{ linkPath: blocked, error: expect.stringContaining("blocked") }],
      });
      const saved = await loadState(homeDir);
      expect(saved.links).toHaveLength(failure === "remove" ? 2 : 1);
      if (failure === "remove")
        expect(saved.links.find((link) => link.path === blocked)?.target).toBe(
          NodePath.join(catalogDir, "skills", "explain"),
        );
      vi.restoreAllMocks();
      await apply(["core"], otherCatalog);
      expect(
        (await loadState(homeDir)).links.every(
          (link) => link.target === NodePath.join(otherCatalog, "skills", "explain"),
        ),
      ).toBe(true);
    },
  );

  it.each(["throw", "mismatch"])(
    "preserves counts and ownership on verification %s",
    async (failure) => {
      await expect(
        apply(["core"], catalogDir, {
          verifyLinks: async () => {
            if (failure === "throw") throw new Error("verification denied");
            return [NodePath.join(dirs()[0]!, "explain")];
          },
        }),
      ).rejects.toMatchObject({
        name: "IncompleteApplyError",
        result: {
          installed: 2,
          failed: [
            {
              error: expect.stringContaining(
                failure === "throw" ? "verification denied" : "not verified",
              ),
            },
          ],
        },
      });
      expect((await loadState(homeDir)).links).toHaveLength(2);
      expect(await apply(["core"])).toMatchObject({ unchanged: 2 });
    },
  );

  it.each([false, true])(
    "preserves partial counts and prior state when persistence fails (link failure %s)",
    async (failLink) => {
      await saveState(homeDir, { folder: catalogDir, groups: [], links: [] });
      const previous = await NodeFSP.readFile(stateFilePath(homeDir), "utf8");
      const originalSymlink = NodeFSP.symlink;
      if (failLink)
        vi.spyOn(NodeFSP, "symlink").mockImplementation(async (target, path, type) => {
          if (path === NodePath.join(dirs()[1]!, "explain")) throw new Error("link denied");
          return originalSymlink(target, path, type);
        });
      vi.spyOn(NodeFSP, "rename").mockRejectedValueOnce(new Error("save denied"));
      await expect(apply(["core"])).rejects.toMatchObject({
        name: "IncompleteApplyError",
        message: expect.stringContaining("state save failed"),
        result: { installed: failLink ? 1 : 2 },
      });
      expect(await NodeFSP.readFile(stateFilePath(homeDir), "utf8")).toBe(previous);
      vi.restoreAllMocks();
      await apply(["core"]);
      expect((await loadState(homeDir)).links).toHaveLength(2);
    },
  );
});

describe("state, targets and descriptions", () => {
  it("writes state atomically with private permissions", async () => {
    const initial = { folder: catalogDir, groups: [], links: [] };
    await saveState(homeDir, initial);
    const oldFile = await NodeFSP.open(stateFilePath(homeDir));
    try {
      await saveState(homeDir, { ...initial, groups: ["core"] });
      expect(JSON.parse(await oldFile.readFile("utf8"))).toEqual(initial);
      expect((await loadState(homeDir)).groups).toEqual(["core"]);
      if (!windows) expect((await NodeFSP.stat(stateFilePath(homeDir))).mode & 0o777).toBe(0o600);
      expect(await NodeFSP.readdir(NodePath.dirname(stateFilePath(homeDir)))).toEqual([
        "skill-catalog.json",
      ]);
    } finally {
      await oldFile.close();
    }
  });

  it("preserves malformed state and installed links", async () => {
    await apply(["core"]);
    await NodeFSP.writeFile(stateFilePath(homeDir), "{malformed");
    await expect(apply([])).rejects.toBeInstanceOf(SyntaxError);
    expect(await NodeFSP.readFile(stateFilePath(homeDir), "utf8")).toBe("{malformed");
    for (const dir of dirs())
      expect((await NodeFSP.lstat(NodePath.join(dir, "explain"))).isSymbolicLink()).toBe(true);
  });

  it("honors absolute and relative Claude targets, deduplicates roots, and migrates relative ownership", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", NodePath.join(root, "custom"));
    await apply(["core"]);
    expect(
      (await NodeFSP.lstat(NodePath.join(root, "custom", "skills", "explain"))).isSymbolicLink(),
    ).toBe(true);
    expect(
      targetDirs(homeDir, { CLAUDE_CONFIG_DIR: NodePath.join(homeDir, ".agents") }, catalogDir),
    ).toEqual([NodePath.join(homeDir, ".agents", "skills")]);
    vi.stubEnv("CLAUDE_CONFIG_DIR", "claude-config");
    const relativePath = NodePath.join("claude-config", "skills", "explain");
    const oldTarget = NodePath.join(root, "old-target");
    await NodeFSP.mkdir(oldTarget);
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(catalogDir, relativePath)), {
      recursive: true,
    });
    await NodeFSP.symlink(oldTarget, NodePath.join(catalogDir, relativePath), linkType);
    await saveState(homeDir, {
      folder: catalogDir,
      groups: ["core"],
      links: [{ path: relativePath, target: oldTarget }],
    });
    expect(await apply(["core"])).toMatchObject({ installed: 1, unchanged: 1 });
    expect((await loadState(homeDir)).links.every((link) => NodePath.isAbsolute(link.path))).toBe(
      true,
    );
    expect(await apply([])).toMatchObject({ removed: 2 });
    await expect(NodeFSP.lstat(NodePath.join(catalogDir, relativePath))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects relative ownership without an absolute saved folder", async () => {
    for (const folder of [null, "relative"]) {
      await saveState(homeDir, {
        folder,
        groups: [],
        links: [{ path: "skills/explain", target: catalogDir }],
      });
      await expect(loadState(homeDir)).rejects.toThrow("saved catalog folder is not absolute");
    }
  });

  it("reads untruncated multiline frontmatter and tolerates missing or malformed descriptions", async () => {
    const file = NodePath.join(catalogDir, "skills", "explain", "SKILL.md");
    const long = "description ".repeat(30).trim();
    await NodeFSP.writeFile(
      file,
      `---\r\ndescription: |\r\n  ${long}\r\n  More details\r\n---\r\n`,
    );
    expect(await skillDescription(catalogDir, "explain")).toBe(`${long} More details`);
    for (const text of ["No frontmatter", "---\ndescription: [broken\n---\n"]) {
      await NodeFSP.writeFile(file, text);
      expect(await skillDescription(catalogDir, "explain")).toBe("");
    }
    expect(await skillDescription(catalogDir, "missing")).toBe("");
  });
});
