import type { ProviderInstanceId, ServerProvider, ServerProviderSkill } from "@t3tools/contracts";

import { SKILL_ORIGINS, skillOrigin, type SkillOrigin } from "@t3tools/contracts";
export { SKILL_ORIGINS, skillOrigin, type SkillOrigin } from "@t3tools/contracts";

export type SkillDiscoveryState = "checked" | "not-checked" | "failed";

export interface SkillInventoryRow {
  readonly key: string;
  readonly origin: SkillOrigin;
  readonly records: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ServerProviderSkill>>;
}

export function skillDiscoveryState(provider: ServerProvider, cwd?: string): SkillDiscoveryState {
  const workspace = cwd
    ? provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd)
    : undefined;
  if (workspace?.refreshError || provider.status === "error") return "failed";
  if (
    !provider.enabled ||
    !provider.installed ||
    provider.availability === "unavailable" ||
    provider.status !== "ready" ||
    (cwd && !workspace)
  )
    return "not-checked";
  return "checked";
}

export function buildSkillInventory(
  providers: ReadonlyArray<ServerProvider>,
  cwd?: string,
  catalogSource?: string,
): SkillInventoryRow[] {
  const rows = new Map<
    string,
    { key: string; origin: SkillOrigin; records: Map<ProviderInstanceId, ServerProviderSkill[]> }
  >();
  for (const provider of providers) {
    const workspace = cwd
      ? provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd)
      : undefined;
    for (const skill of workspace?.skills ?? provider.skills) {
      // Unresolved paths are not evidence that two providers see the same file.
      const key = skill.linkTarget
        ? JSON.stringify(["resolved", skill.linkTarget])
        : JSON.stringify([provider.instanceId, skill.path, skill.name, skill.pluginId]);
      const origin = skillOrigin(skill, cwd, catalogSource);
      const row = rows.get(key) ?? { key, origin, records: new Map() };
      if (SKILL_ORIGINS.indexOf(origin) < SKILL_ORIGINS.indexOf(row.origin)) row.origin = origin;
      row.records.set(provider.instanceId, [
        ...(row.records.get(provider.instanceId) ?? []),
        skill,
      ]);
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort(
    (a, b) =>
      [...a.records.values()][0]![0]!.name.localeCompare([...b.records.values()][0]![0]!.name) ||
      a.key.localeCompare(b.key),
  );
}

export function filterSkillInventory(
  rows: ReadonlyArray<SkillInventoryRow>,
  query: string,
  instanceId?: ProviderInstanceId,
): SkillInventoryRow[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((row) => {
    if (instanceId && !row.records.has(instanceId)) return false;
    const text = [
      row.origin,
      ...[...row.records.values()]
        .flat()
        .flatMap((skill) => [
          skill.name,
          skill.displayName,
          skill.description,
          skill.shortDescription,
          skill.path,
          skill.linkTarget,
          skill.pluginId,
        ]),
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

export function missingSkillLabel(state: SkillDiscoveryState): string {
  return state === "checked"
    ? "Not detected"
    : state === "failed"
      ? "Refresh failed"
      : "Not checked";
}
