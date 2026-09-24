// @effect-diagnostics nodeBuiltinImport:off - exercise native symlink identity and Windows junction operations.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  ProviderInstanceId,
  type SkillLinkPreview,
  type SkillLinkRequest,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Yaml from "yaml";
import {
  canonicalSkillRoot,
  createManagedSkillLink,
  listManagedSkillLinks,
  previewSkillLink,
  removeManagedSkillLink,
} from "./skillLinks.ts";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof NodeFSP>()) }));
vi.mock("yaml", async (original) => ({ ...(await original<typeof Yaml>()) }));
let root: string;
let source: string;
let destination: string;
let state: string;
const request: SkillLinkRequest = {
  source: { instanceId: ProviderInstanceId.make("codex"), path: "/unused", name: "example" },
  targetInstanceId: ProviderInstanceId.make("claude"),
  scope: "user",
};
const contents =
  "---\nname: example\ndescription: An example skill\n---\nUse scripts/run.sh and references/guide.md.\n";
beforeEach(async () => {
  root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "skill-links-")),
  );
  source = NodePath.join(root, "source", "example");
  destination = NodePath.join(root, "home", ".claude", "skills");
  state = NodePath.join(root, "state");
  await NodeFSP.mkdir(source, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(source, "SKILL.md"), contents);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await NodeFSP.rm(root, { recursive: true, force: true });
});
async function preview(): Promise<SkillLinkPreview> {
  return { ...(await previewSkillLink(source, destination, "claudeAgent")), sharedWith: [] };
}
async function create(windows = false) {
  const checked = await preview();
  const action = await createManagedSkillLink(state, checked, request, windows);
  return { checked, action, record: (await listManagedSkillLinks(state))[0]! };
}

describe("managed skill links", () => {
  it("parses frontmatter once while retaining raw compatibility fields and validation", async () => {
    await NodeFSP.writeFile(
      NodePath.join(source, "SKILL.md"),
      "---\nname: example\ndescription: Example\nuser-invocable: no\nallowed-tools: [Read]\nhooks: {}\n---\n$ARGUMENTS\n",
    );
    const parse = vi.spyOn(Yaml, "parse");
    const checked = await previewSkillLink(source, destination, "codex");
    expect(parse).toHaveBeenCalledTimes(1);
    expect(checked.warnings).toEqual([
      "Claude-specific frontmatter (allowed-tools, hooks, user-invocable) is not translated to Codex behavior.",
      "The skill uses Claude argument substitutions, environment variables, or !`command` expansion; Codex may not interpret them.",
    ]);
    await NodeFSP.writeFile(
      NodePath.join(source, "SKILL.md"),
      "---\nname: example\ndescription: [not, a, string]\n---\n",
    );
    await expect(previewSkillLink(source, destination, "codex")).rejects.toThrow(
      "Codex requires nonempty name and description",
    );
  });
  it("preserves a provider-discovered folder name and explains Claude's command name", async () => {
    const renamed = `${source}.v2`;
    await NodeFSP.rename(source, renamed);
    source = renamed;
    const { checked } = await create();
    expect(checked.destinationPath).toBe(NodePath.join(destination, "example.v2"));
    expect(checked.warnings.join(" ")).toContain("/example.v2");
  });
  it("can unlink an unchanged link even when the source is unreadable", async () => {
    const { record } = await create();
    vi.spyOn(NodeFSP, "stat").mockRejectedValue(new Error("permission denied"));
    expect((await listManagedSkillLinks(state))[0]!.status).toBe("broken");
    await removeManagedSkillLink(state, record.id, false);
    expect(await listManagedSkillLinks(state)).toEqual([]);
  });
  it.each([false, true])(
    "shares every file and unlinks only the recorded directory (junction=%s)",
    async (windows) => {
      await NodeFSP.mkdir(NodePath.join(source, "scripts"));
      await NodeFSP.mkdir(NodePath.join(source, "references"));
      await NodeFSP.mkdir(NodePath.join(source, "assets"));
      await NodeFSP.writeFile(NodePath.join(source, "scripts", "run.sh"), "first");
      await NodeFSP.writeFile(NodePath.join(source, "references", "guide.md"), "guide");
      await NodeFSP.writeFile(NodePath.join(source, "assets", "icon.svg"), "icon");
      const spy = vi.spyOn(NodeFSP, "symlink");
      const { checked, record } = await create(windows);
      expect(spy).toHaveBeenCalledWith(
        source,
        checked.destinationPath,
        windows ? "junction" : "dir",
      );
      expect(record.status).toBe("linked");
      await NodeFSP.writeFile(NodePath.join(source, "scripts", "run.sh"), "updated");
      expect(
        await NodeFSP.readFile(NodePath.join(checked.destinationPath, "scripts", "run.sh"), "utf8"),
      ).toBe("updated");
      await NodeFSP.writeFile(
        NodePath.join(checked.destinationPath, "SKILL.md"),
        `${contents}\nShared edit`,
      );
      expect(await NodeFSP.readFile(NodePath.join(source, "SKILL.md"), "utf8")).toContain(
        "Shared edit",
      );
      expect(
        await NodeFSP.readFile(
          NodePath.join(checked.destinationPath, "references", "guide.md"),
          "utf8",
        ),
      ).toBe("guide");
      expect(
        await NodeFSP.readFile(
          NodePath.join(checked.destinationPath, "assets", "icon.svg"),
          "utf8",
        ),
      ).toBe("icon");
      expect((await create()).action).toBe("unchanged");
      expect(await listManagedSkillLinks(state)).toHaveLength(1);
      await removeManagedSkillLink(state, record.id, windows);
      expect(await listManagedSkillLinks(state)).toEqual([]);
      expect(await NodeFSP.readFile(NodePath.join(source, "SKILL.md"), "utf8")).toContain(
        "Shared edit",
      );
      expect(await removeManagedSkillLink(state, record.id, windows)).toBeUndefined();
    },
  );
  it("leaves a matching foreign link unmanaged", async () => {
    await NodeFSP.mkdir(destination, { recursive: true });
    await NodeFSP.symlink(source, NodePath.join(destination, "example"), "dir");
    expect((await create()).action).toBe("unchanged");
    expect(await listManagedSkillLinks(state)).toEqual([]);
  });
  it.each(["file", "directory", "link"])(
    "rejects an existing %s and a conflict introduced after preview",
    async (kind) => {
      const checked = await preview();
      await NodeFSP.mkdir(destination, { recursive: true });
      if (kind === "file") await NodeFSP.writeFile(checked.destinationPath, "foreign");
      else if (kind === "directory") await NodeFSP.mkdir(checked.destinationPath);
      else await NodeFSP.symlink(NodePath.join(root, "missing"), checked.destinationPath, "dir");
      expect((await preview()).status).toBe("conflict");
      await expect(createManagedSkillLink(state, checked, request, false)).rejects.toThrow(
        /changed since inspection/,
      );
      expect(await listManagedSkillLinks(state)).toEqual([]);
    },
  );
  it("keeps broken links visible and removable when their source disappears", async () => {
    const { record } = await create();
    await NodeFSP.rm(source, { recursive: true });
    expect((await listManagedSkillLinks(state))[0]!.status).toBe("broken");
    await removeManagedSkillLink(state, record.id, false);
    expect(await listManagedSkillLinks(state)).toEqual([]);
  });
  it("refuses a changed target or a replacement even if it points at the same source", async () => {
    const { record } = await create();
    await NodeFSP.rename(record.destinationPath, `${record.destinationPath}-original`);
    await NodeFSP.symlink(source, record.destinationPath, "dir");
    expect((await listManagedSkillLinks(state))[0]!.status).toBe("changed");
    await expect(removeManagedSkillLink(state, record.id, false)).rejects.toThrow(
      /replaced or changed/,
    );
    await NodeFSP.unlink(record.destinationPath);
    await NodeFSP.symlink(root, record.destinationPath, "dir");
    await expect(removeManagedSkillLink(state, record.id, false)).rejects.toThrow(
      /replaced or changed/,
    );
    expect(await NodeFSP.realpath(record.destinationPath)).toBe(root);
  });
  it("forgets a changed record without touching the replacement and permits a later fresh link", async () => {
    const { record } = await create();
    await NodeFSP.unlink(record.destinationPath);
    await NodeFSP.writeFile(record.destinationPath, "replacement");
    await removeManagedSkillLink(state, record.id, false, true);
    expect(await listManagedSkillLinks(state)).toEqual([]);
    expect(await NodeFSP.readFile(record.destinationPath, "utf8")).toBe("replacement");
    expect(await NodeFSP.readFile(NodePath.join(source, "SKILL.md"), "utf8")).toBe(contents);
    await NodeFSP.unlink(record.destinationPath);
    expect((await create()).action).toBe("created");
  });
  it("retains ownership across metadata edits and accepts the previous identity format", async () => {
    const { record } = await create();
    const file = NodePath.join(state, "skill-links.json");
    const records = JSON.parse(await NodeFSP.readFile(file, "utf8"));
    records[0].identity += ":old-ctime";
    await NodeFSP.writeFile(file, JSON.stringify(records));
    const time = (await NodeFSP.lstat(record.destinationPath)).mtimeMs / 1000 + 1;
    await NodeFSP.lutimes(record.destinationPath, time, time);
    expect((await listManagedSkillLinks(state))[0]!.status).toBe("linked");
    await removeManagedSkillLink(state, record.id, false);
    expect(await listManagedSkillLinks(state)).toEqual([]);
  });
  it("rejects a project root redirected outside the project but allows an internal alias", async () => {
    const project = NodePath.join(root, "project");
    await NodeFSP.mkdir(project);
    const providerDir = NodePath.join(project, ".claude");
    await NodeFSP.symlink(NodePath.dirname(source), providerDir, "dir");
    await expect(
      previewSkillLink(source, NodePath.join(providerDir, "skills"), "claudeAgent", project),
    ).rejects.toThrow(/outside the selected project/);
    await NodeFSP.unlink(providerDir);
    const internal = NodePath.join(project, "config");
    await NodeFSP.mkdir(internal);
    await NodeFSP.symlink(internal, providerDir, "dir");
    expect(
      (await previewSkillLink(source, NodePath.join(providerDir, "skills"), "claudeAgent", project))
        .destinationPath,
    ).toBe(NodePath.join(internal, "skills", "example"));
  });
  it("rolls back when the initial ownership identity cannot be read", async () => {
    const lstat = NodeFSP.lstat;
    const spy = vi
      .spyOn(NodeFSP, "lstat")
      .mockImplementation(async (...args: Parameters<typeof lstat>) => {
        const info = await lstat(...args);
        if (String(args[0]) === NodePath.join(destination, "example") && info.isSymbolicLink()) {
          spy.mockRestore();
          throw new Error("identity unavailable");
        }
        return info;
      });
    await expect(create()).rejects.toThrow("identity unavailable");
    await expect(NodeFSP.lstat(NodePath.join(destination, "example"))).rejects.toThrow(/ENOENT/);
    expect(await listManagedSkillLinks(state)).toEqual([]);
  });
  it("removes a missing link's record without touching an unrelated file", async () => {
    const { record } = await create();
    await NodeFSP.unlink(record.destinationPath);
    expect((await listManagedSkillLinks(state))[0]!.status).toBe("missing");
    await removeManagedSkillLink(state, record.id, false);
    expect(await NodeFSP.readFile(NodePath.join(source, "SKILL.md"), "utf8")).toBe(contents);
  });
  it("rejects a missing source and rechecks it immediately before writing", async () => {
    const checked = await preview();
    await NodeFSP.rm(source, { recursive: true });
    await expect(preview()).rejects.toThrow(/ENOENT/);
    await expect(createManagedSkillLink(state, checked, request, false)).rejects.toThrow(/ENOENT/);
    expect(await listManagedSkillLinks(state)).toEqual([]);
  });
  it("rolls back a created link when ownership persistence fails", async () => {
    vi.spyOn(NodeFSP, "rename").mockRejectedValueOnce(new Error("disk full"));
    await expect(create()).rejects.toThrow("disk full");
    await expect(NodeFSP.lstat(NodePath.join(destination, "example"))).rejects.toThrow(/ENOENT/);
    expect(await NodeFSP.readFile(NodePath.join(source, "SKILL.md"), "utf8")).toBe(contents);
    expect(await NodeFSP.readdir(state)).toEqual([]);
    expect((await create()).action).toBe("created");
  });
  it("does not reset malformed ownership state", async () => {
    await NodeFSP.mkdir(state);
    await NodeFSP.writeFile(NodePath.join(state, "skill-links.json"), "{}");
    await expect(create()).rejects.toThrow();
    expect(await NodeFSP.readFile(NodePath.join(state, "skill-links.json"), "utf8")).toBe("{}");
  });
  it("canonicalizes shared roots and refuses a root redirected after preview", async () => {
    await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
    const shared = NodePath.join(root, "shared");
    await NodeFSP.mkdir(shared);
    await NodeFSP.symlink(shared, destination, "dir");
    expect(await canonicalSkillRoot(destination)).toBe(shared);
    const checked = await preview();
    expect(checked.destinationPath).toBe(NodePath.join(shared, "example"));
    await NodeFSP.rmdir(shared);
    await NodeFSP.symlink(source, shared, "dir");
    await expect(createManagedSkillLink(state, checked, request, false)).rejects.toThrow(
      /Destination changed/,
    );
  });
  it("links a directory containing a symlinked SKILL.md without losing adjacent assets", async () => {
    const metadata = NodePath.join(root, "metadata.md");
    await NodeFSP.rename(NodePath.join(source, "SKILL.md"), metadata);
    await NodeFSP.symlink(metadata, NodePath.join(source, "SKILL.md"));
    const checked = await previewSkillLink(NodePath.join(source, "SKILL.md"), destination, "codex");
    expect(checked.sourcePath).toBe(source);
  });
  it("validates the target metadata and reports concrete provider dependencies", async () => {
    await NodeFSP.writeFile(NodePath.join(source, "SKILL.md"), "Instructions without frontmatter");
    await expect(previewSkillLink(source, destination, "codex")).rejects.toThrow(
      /name and description/,
    );
    expect((await preview()).status).toBe("available");
    await NodeFSP.writeFile(
      NodePath.join(source, "SKILL.md"),
      "---\nname: example\ndescription: Test\ncontext: fork\nhooks: {}\n---\n$ARGUMENTS mcp__tools__search !`date`\n",
    );
    const codex = await previewSkillLink(source, destination, "codex");
    expect(codex.warnings.join(" ")).toContain("context, hooks");
    expect(codex.warnings.join(" ")).toContain("mcp__tools__search");
    await NodeFSP.mkdir(NodePath.join(source, "agents"));
    await NodeFSP.writeFile(
      NodePath.join(source, "agents", "openai.yaml"),
      "policy:\n  allow_implicit_invocation: false\ndependencies:\n  tools: []\n",
    );
    expect((await preview()).warnings.join(" ")).toContain("Claude does not apply");
    expect((await preview()).warnings.join(" ")).toContain("declares tool dependencies");
  });
});
