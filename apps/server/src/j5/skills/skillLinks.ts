// @effect-diagnostics nodeBuiltinImport:off - ownership requires lstat and directory junctions; RPCs wrap the async boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { ManagedSkillLink, type SkillLinkPreview, type SkillLinkRequest } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { parseSkillFrontmatter } from "../../provider/Drivers/ClaudeSkills.ts";
import { applyPlan } from "./skillCatalogInstaller.ts";
import {
  canonicalSkillRoot,
  isMissing,
  linkDestination,
  readSkillsConcurrently,
  skillLinkIdentity,
  writeSkillStateAtomically,
} from "./skillFileSystem.ts";

export { canonicalSkillRoot } from "./skillFileSystem.ts";

const RecordedLink = Schema.Struct({
  ...ManagedSkillLink.fields,
  identity: Schema.String,
});
type RecordedLink = typeof RecordedLink.Type;
const decodeLinks = Schema.decodeUnknownSync(Schema.Array(RecordedLink));

export async function previewSkillLink(
  source: string,
  root: string,
  driver: string,
  projectRoot?: string,
): Promise<
  Pick<
    SkillLinkPreview,
    "sourcePath" | "destinationPath" | "skillName" | "warnings" | "status" | "conflict"
  >
> {
  const info = await NodeFSP.stat(source);
  const folder = info.isDirectory() ? source : NodePath.dirname(source);
  if (!info.isDirectory() && NodePath.basename(source) !== "SKILL.md") {
    throw new Error("Only a skill directory containing SKILL.md can be linked.");
  }
  const sourcePath = await NodeFSP.realpath(folder);
  const skillName = NodePath.basename(folder);
  // Reuse the existing folder name; it is already valid on this environment's filesystem.
  if (!skillName || skillName === "." || skillName === "..") {
    throw new Error(`The skill folder name cannot be used as a destination: ${skillName}`);
  }
  if (driver === "claudeAgent" && skillName.toLowerCase() === "synced") {
    throw new Error("Claude reserves the skill folder name synced for downloaded skills.");
  }
  const contents = await NodeFSP.readFile(NodePath.join(sourcePath, "SKILL.md"), "utf8");
  const frontmatter = parseSkillFrontmatter(contents);
  if (frontmatter.kind === "malformed") throw new Error("SKILL.md has malformed YAML frontmatter.");
  if (
    driver === "codex" &&
    (frontmatter.kind !== "parsed" || !frontmatter.name || !frontmatter.description)
  ) {
    throw new Error(
      "Codex requires nonempty name and description strings in SKILL.md frontmatter.",
    );
  }
  const warnings: string[] = [];
  if (
    driver === "claudeAgent" &&
    frontmatter.kind === "parsed" &&
    frontmatter.name &&
    frontmatter.name !== skillName
  ) {
    warnings.push(`Claude uses /${skillName} as this skill's command name.`);
  }
  if (driver === "codex") {
    const metadata = frontmatter.kind === "parsed" ? frontmatter.metadata : {};
    const fields = [
      "allowed-tools",
      "disallowed-tools",
      "context",
      "agent",
      "hooks",
      "model",
      "effort",
      "background",
      "arguments",
      "argument-hint",
      "disable-model-invocation",
      "user-invocable",
      "when_to_use",
    ].filter((key) => Object.hasOwn(metadata, key));
    if (fields.length)
      warnings.push(
        `Claude-specific frontmatter (${fields.join(", ")}) is not translated to Codex behavior.`,
      );
    if (/\$(?:ARGUMENTS|CLAUDE_[A-Z_]+|\d)|!`/.test(contents))
      warnings.push(
        "The skill uses Claude argument substitutions, environment variables, or !`command` expansion; Codex may not interpret them.",
      );
  }
  const openaiMetadata = await NodeFSP.readFile(
    NodePath.join(sourcePath, "agents", "openai.yaml"),
    "utf8",
  ).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (openaiMetadata !== undefined) {
    if (driver === "claudeAgent")
      warnings.push(
        "agents/openai.yaml contains Codex metadata or invocation policy that Claude does not apply.",
      );
    if (/^dependencies\s*:/m.test(openaiMetadata))
      warnings.push(
        "agents/openai.yaml declares tool dependencies. Configure those tools separately in the destination provider.",
      );
  }
  const mcpTools = [...new Set(contents.match(/mcp__[\w-]+__[\w-]+/g) ?? [])];
  if (mcpTools.length)
    warnings.push(`Referenced MCP tools need separate configuration: ${mcpTools.join(", ")}.`);
  const scripts = await NodeFSP.readdir(NodePath.join(sourcePath, "scripts")).catch(
    (error: unknown) => {
      if (isMissing(error)) return [];
      throw error;
    },
  );
  if (scripts.length)
    warnings.push(
      `Shared scripts (${scripts.slice(0, 5).join(", ")}${scripts.length > 5 ? ", …" : ""}) may require runtimes or packages in this environment.`,
    );
  const canonicalRoot = await canonicalSkillRoot(root);
  if (projectRoot) {
    const relative = NodePath.relative(await NodeFSP.realpath(projectRoot), canonicalRoot);
    if (
      relative === ".." ||
      relative.startsWith(`..${NodePath.sep}`) ||
      NodePath.isAbsolute(relative)
    )
      throw new Error("Project skill destination resolves outside the selected project.");
  }
  const destinationPath = NodePath.join(canonicalRoot, skillName);
  const seen = await linkDestination(destinationPath);
  const sameTarget =
    seen.kind === "link" &&
    (await NodeFSP.realpath(destinationPath).then(
      (target) => target === sourcePath,
      () => false,
    ));
  const status = seen.kind === "absent" ? "available" : sameTarget ? "already-linked" : "conflict";
  return {
    sourcePath,
    destinationPath,
    skillName,
    warnings,
    status,
    ...(status === "conflict"
      ? {
          conflict: `Destination already exists (${seen.kind === "link" ? `points at ${seen.raw}` : seen.kind}). Nothing will be overwritten.`,
        }
      : {}),
  };
}

async function linkStatus(link: RecordedLink): Promise<ManagedSkillLink["status"]> {
  const seen = await linkDestination(link.destinationPath);
  if (seen.kind === "absent") return "missing";
  if (
    seen.kind !== "link" ||
    seen.target !== link.sourcePath ||
    // Older records appended ctime, which changes on metadata edits without replacing the link.
    (await skillLinkIdentity(link.destinationPath)) !==
      link.identity.split(":").slice(0, 3).join(":")
  )
    return "changed";
  return await NodeFSP.stat(NodePath.join(link.sourcePath, "SKILL.md")).then(
    (stat) => (stat.isFile() ? "linked" : "broken"),
    () => "broken",
  );
}

export async function loadManagedSkillLinks(
  stateDir: string,
): Promise<ReadonlyArray<RecordedLink>> {
  const contents = await NodeFSP.readFile(
    NodePath.join(stateDir, "skill-links.json"),
    "utf8",
  ).catch((error: unknown) => {
    if (isMissing(error)) return "[]";
    throw error;
  });
  return decodeLinks(JSON.parse(contents));
}

async function saveLinks(stateDir: string, links: ReadonlyArray<RecordedLink>) {
  await writeSkillStateAtomically(
    NodePath.join(stateDir, "skill-links.json"),
    `${JSON.stringify(links, null, 2)}\n`,
  );
}

export async function listManagedSkillLinks(
  stateDir: string,
): Promise<ReadonlyArray<ManagedSkillLink>> {
  return readSkillsConcurrently(await loadManagedSkillLinks(stateDir), async (record) => {
    const { identity: _, ...link } = record;
    return { ...link, status: await linkStatus(record) };
  });
}

/** Called under the RPC mutation permit, after recomputing and checking the preview. */
export async function createManagedSkillLink(
  stateDir: string,
  preview: SkillLinkPreview,
  request: SkillLinkRequest,
  windows: boolean,
) {
  const links = await loadManagedSkillLinks(stateDir);
  if (preview.status === "conflict") throw new Error(preview.conflict);
  // A matching foreign link stays foreign; repeating a request must not claim it.
  if (preview.status === "already-linked") return "unchanged" as const;
  if (links.some((link) => link.destinationPath === preview.destinationPath))
    throw new Error(
      "A managed record already exists for this destination. Remove it before linking again.",
    );
  const entry = {
    skill: preview.skillName,
    linkPath: preview.destinationPath,
    target: preview.sourcePath,
  };
  // Source removal or a parent redirect after preview must not silently change the operation.
  if (
    (await canonicalSkillRoot(NodePath.dirname(entry.linkPath))) !==
    NodePath.dirname(entry.linkPath)
  )
    throw new Error("Destination changed. Preview again.");
  await NodeFSP.access(NodePath.join(entry.target, "SKILL.md"));
  const result = await applyPlan({ additions: [entry], removals: [] }, { windows });
  if (result.failed.length) throw new Error(result.failed[0]!.error);
  const identity = result.applied[0]!.identity!;
  try {
    const record: RecordedLink = {
      id: NodeCrypto.randomUUID(),
      skillName: preview.skillName,
      sourcePath: entry.target,
      destinationPath: entry.linkPath,
      targetInstanceId: request.targetInstanceId,
      scope: request.scope,
      ...(request.projectId ? { projectId: request.projectId } : {}),
      status: "linked",
      identity,
    };
    await saveLinks(stateDir, [...links, record]);
  } catch (error) {
    if ((await skillLinkIdentity(entry.linkPath)) === identity) {
      const rollback = await applyPlan({ additions: [], removals: [entry] }, { windows });
      if (rollback.failed.length)
        throw new Error(
          `Link created but ownership could not be saved or rolled back: ${entry.linkPath}. ${rollback.failed[0]!.error}`,
          { cause: error },
        );
    }
    throw error;
  }
  return "created" as const;
}

export async function removeManagedSkillLink(
  stateDir: string,
  id: string,
  windows: boolean,
  forget = false,
) {
  const links = await loadManagedSkillLinks(stateDir);
  const link = links.find((entry) => entry.id === id);
  if (!link) return undefined;
  const status = forget ? "missing" : await linkStatus(link);
  if (status === "changed")
    throw new Error("The recorded link was replaced or changed. It will not be removed.");
  if (status !== "missing") {
    const result = await applyPlan(
      {
        additions: [],
        removals: [
          { skill: link.skillName, linkPath: link.destinationPath, target: link.sourcePath },
        ],
      },
      { windows },
    );
    if (result.failed.length) throw new Error(result.failed[0]!.error);
  }
  await saveLinks(
    stateDir,
    links.filter((entry) => entry.id !== id),
  );
  return link;
}
