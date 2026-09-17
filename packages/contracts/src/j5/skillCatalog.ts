import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { EnvironmentAuthorizationError } from "../auth.ts";

export const SkillCatalogName = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/));
export const SkillCatalogGroup = Schema.Struct({
  id: SkillCatalogName,
  description: Schema.String,
  skills: Schema.Array(SkillCatalogName),
  depends: Schema.Array(SkillCatalogName),
});
export type SkillCatalogGroup = typeof SkillCatalogGroup.Type;

export const SkillCatalogSnapshot = Schema.Struct({
  folder: Schema.NullOr(Schema.String),
  selectedGroups: Schema.Array(SkillCatalogName),
  groups: Schema.Array(SkillCatalogGroup),
  targets: Schema.Array(Schema.String),
});
export type SkillCatalogSnapshot = typeof SkillCatalogSnapshot.Type;

export class SkillCatalogError extends Schema.TaggedErrorClass<SkillCatalogError>()(
  "SkillCatalogError",
  { message: Schema.String },
) {}

export const SkillCatalogReadInput = Schema.Struct({ folder: Schema.optional(Schema.String) });
export type SkillCatalogReadInput = typeof SkillCatalogReadInput.Type;
export const SkillCatalogApplyInput = Schema.Struct({
  folder: Schema.String.check(Schema.isNonEmpty()),
  groups: Schema.Array(SkillCatalogName),
});
export type SkillCatalogApplyInput = typeof SkillCatalogApplyInput.Type;

export const SKILL_CATALOG_METHODS = {
  read: "j5.skills.readCatalog",
  apply: "j5.skills.applyGroups",
} as const;

export const SkillCatalogRpcGroup = RpcGroup.make(
  Rpc.make(SKILL_CATALOG_METHODS.read, {
    payload: SkillCatalogReadInput,
    success: SkillCatalogSnapshot,
    error: Schema.Union([SkillCatalogError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(SKILL_CATALOG_METHODS.apply, {
    payload: SkillCatalogApplyInput,
    success: SkillCatalogSnapshot,
    error: Schema.Union([SkillCatalogError, EnvironmentAuthorizationError]),
  }),
);

/** Resolve required groups for both installation and the selection preview. */
export function resolveSkillCatalogGroups(
  groups: ReadonlyArray<SkillCatalogGroup>,
  selected: ReadonlyArray<string>,
): ReadonlyArray<SkillCatalogGroup> {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const resolved = new Set<string>();
  const visiting = new Set<string>();
  function visit(id: string) {
    const group = byId.get(id);
    if (!group) throw new Error(`Unknown skill group: ${id}`);
    if (visiting.has(id)) throw new Error(`Skill group dependency cycle: ${id}`);
    if (resolved.has(id)) return;
    visiting.add(id);
    for (const dependency of group.depends) visit(dependency);
    visiting.delete(id);
    resolved.add(id);
  }
  for (const id of selected) visit(id);
  return groups.filter((group) => resolved.has(group.id));
}
