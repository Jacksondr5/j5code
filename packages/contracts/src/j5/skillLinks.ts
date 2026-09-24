import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { EnvironmentAuthorizationError } from "../auth.ts";
import { ProjectId, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { ProviderInstanceId } from "../providerInstance.ts";

export const SkillLinkRequest = Schema.Struct({
  source: Schema.Struct({
    instanceId: ProviderInstanceId,
    path: TrimmedNonEmptyString,
    name: TrimmedNonEmptyString,
  }),
  targetInstanceId: ProviderInstanceId,
  scope: Schema.Literals(["user", "project"]),
  /** Discovery context and, for project scope, the destination project. */
  projectId: Schema.optional(ProjectId),
});
export type SkillLinkRequest = typeof SkillLinkRequest.Type;

export const SkillLinkPreview = Schema.Struct({
  sourcePath: TrimmedNonEmptyString,
  destinationPath: TrimmedNonEmptyString,
  skillName: TrimmedNonEmptyString,
  sharedWith: Schema.Array(Schema.Struct({ instanceId: ProviderInstanceId, label: Schema.String })),
  warnings: Schema.Array(Schema.String),
  status: Schema.Literals(["available", "already-linked", "conflict"]),
  conflict: Schema.optional(Schema.String),
});
export type SkillLinkPreview = typeof SkillLinkPreview.Type;

export const SkillLinkCreate = Schema.Struct({
  ...SkillLinkRequest.fields,
  expectedSourcePath: TrimmedNonEmptyString,
  expectedDestinationPath: TrimmedNonEmptyString,
});
export type SkillLinkCreate = typeof SkillLinkCreate.Type;

export const ManagedSkillLink = Schema.Struct({
  id: TrimmedNonEmptyString,
  skillName: TrimmedNonEmptyString,
  sourcePath: TrimmedNonEmptyString,
  destinationPath: TrimmedNonEmptyString,
  targetInstanceId: ProviderInstanceId,
  scope: Schema.Literals(["user", "project"]),
  projectId: Schema.optional(ProjectId),
  status: Schema.Literals(["linked", "broken", "missing", "changed"]),
});
export type ManagedSkillLink = typeof ManagedSkillLink.Type;

export const SkillLinkMutationResult = Schema.Struct({
  action: Schema.Literals(["created", "unchanged", "removed", "forgotten"]),
  discovery: Schema.Literals(["detected", "not-detected", "failed", "not-checked"]),
  message: Schema.String,
});
export type SkillLinkMutationResult = typeof SkillLinkMutationResult.Type;

export class SkillLinkError extends Schema.TaggedError<SkillLinkError>()("SkillLinkError", {
  message: Schema.String,
}) {}

export const J5_SKILL_LINK_WS_METHODS = {
  preview: "j5.skills.links.preview",
  create: "j5.skills.links.create",
  list: "j5.skills.links.list",
  remove: "j5.skills.links.remove",
} as const;
const errors = Schema.Union([EnvironmentAuthorizationError, SkillLinkError]);
export const J5SkillLinkRpcGroup = RpcGroup.make(
  Rpc.make(J5_SKILL_LINK_WS_METHODS.preview, {
    payload: SkillLinkRequest,
    success: SkillLinkPreview,
    error: errors,
  }),
  Rpc.make(J5_SKILL_LINK_WS_METHODS.create, {
    payload: SkillLinkCreate,
    success: SkillLinkMutationResult,
    error: errors,
  }),
  Rpc.make(J5_SKILL_LINK_WS_METHODS.list, {
    payload: Schema.Struct({}),
    success: Schema.Array(ManagedSkillLink),
    error: errors,
  }),
  Rpc.make(J5_SKILL_LINK_WS_METHODS.remove, {
    payload: Schema.Struct({ id: TrimmedNonEmptyString, forget: Schema.optional(Schema.Boolean) }),
    success: SkillLinkMutationResult,
    error: errors,
  }),
);
