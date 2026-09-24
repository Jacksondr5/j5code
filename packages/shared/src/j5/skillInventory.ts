import type { ServerProvider, ServerProviderSkill } from "@t3tools/contracts";

export const SKILL_ORIGINS = [
  "Plugin",
  "Catalog",
  "Project",
  "Personal",
  "Built-in",
  "Other",
] as const;
export type SkillOrigin = (typeof SKILL_ORIGINS)[number];
// Paths belong to the selected environment, which may run Windows even when
// this browser does not. Never resolve them against the browser's location.
export function normalizePath(value: string): string {
  const parts: string[] = [];
  for (const part of value.replaceAll("\\", "/").replace(/\/+/g, "/").split("/")) {
    if (part === ".") continue;
    if (part === ".." && parts.length > 1) parts.pop();
    else parts.push(part);
  }
  return parts.join("/").replace(/\/+$/, "");
}

function containsPath(root: string, file: string): boolean {
  const directory = normalizePath(root);
  const location = normalizePath(file);
  return location === directory || location.startsWith(`${directory}/`);
}

export function skillOrigin(
  skill: ServerProviderSkill,
  cwd?: string,
  catalogSource?: string,
): SkillOrigin {
  if (skill.pluginId || skill.scope?.toLowerCase() === "plugin") return "Plugin";
  const locations = [skill.path, skill.linkTarget].filter((p): p is string => p !== undefined);
  if (
    locations.some((location) =>
      /\/(?:\.codex|\.claude|\.agents)\/plugins\//.test(normalizePath(location)),
    )
  )
    return "Plugin";
  if (
    locations.some(
      (location) =>
        /\/skill-catalogs\/[^/]+\/catalog\//.test(normalizePath(location)) ||
        (catalogSource &&
          /^(\/|[A-Za-z]:[\\/])/.test(catalogSource) &&
          containsPath(catalogSource, location)),
    )
  )
    return "Catalog";
  switch (skill.scope?.trim().toLowerCase()) {
    case "repo":
    case "repository":
    case "project":
    case "workspace":
    case "local":
      return "Project";
    case "user":
    case "personal":
      return "Personal";
    case "admin":
    case "system":
    case "builtin":
    case "built-in":
    case "managed":
      return "Built-in";
  }
  return cwd && containsPath(cwd, skill.path) ? "Project" : "Other";
}

export type SkillDiscoveryState = "checked" | "not-checked" | "failed";

export function skillDiscoveryState(
  provider: ServerProvider | undefined,
  cwd?: string,
): SkillDiscoveryState {
  const workspace = cwd
    ? provider?.workspaceSnapshots?.find(
        (snapshot) => normalizePath(snapshot.cwd) === normalizePath(cwd),
      )
    : undefined;
  if (workspace?.refreshError || provider?.skillDiscoveryError || provider?.status === "error")
    return "failed";
  if (
    !provider?.enabled ||
    !provider.installed ||
    provider.availability === "unavailable" ||
    provider.status !== "ready" ||
    (cwd && !workspace)
  )
    return "not-checked";
  return "checked";
}
