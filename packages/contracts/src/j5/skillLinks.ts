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

export const SkillLinkUnlink = Schema.Struct({
  targetInstanceId: ProviderInstanceId,
  scope: SkillLinkRequest.fields.scope,
  projectId: Schema.optional(ProjectId),
  expectedSourcePath: TrimmedNonEmptyString,
  expectedDestinationPath: TrimmedNonEmptyString,
  expectedIdentity: TrimmedNonEmptyString,
});
export type SkillLinkUnlink = typeof SkillLinkUnlink.Type;

export const SkillLinkInspect = Schema.Struct({
  source: SkillLinkRequest.fields.source,
  projectId: Schema.optional(ProjectId),
});
export type SkillLinkInspect = typeof SkillLinkInspect.Type;

export const SkillDeletePreview = Schema.Struct({
  expectedPath: TrimmedNonEmptyString,
  expectedIdentity: TrimmedNonEmptyString,
});
export type SkillDeletePreview = typeof SkillDeletePreview.Type;
export const SkillDelete = Schema.Struct({
  ...SkillLinkInspect.fields,
  ...SkillDeletePreview.fields,
});
export type SkillDelete = typeof SkillDelete.Type;

export const ExistingSkillLink = Schema.Struct({
  label: Schema.String,
  request: SkillLinkUnlink,
});
export type ExistingSkillLink = typeof ExistingSkillLink.Type;

export const SkillLinkUnlinkBatch = Schema.Struct({
  links: Schema.Array(SkillLinkUnlink).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
export type SkillLinkUnlinkBatch = typeof SkillLinkUnlinkBatch.Type;
export const SkillLinkUnlinkResult = Schema.Struct({
  removedPaths: Schema.Array(Schema.String),
  failed: Schema.Array(Schema.Struct({ path: Schema.String, message: Schema.String })),
  refreshFailed: Schema.Boolean,
});

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
  unlink: "j5.skills.links.unlink",
  inspect: "j5.skills.links.inspect",
  deletePreview: "j5.skills.links.deletePreview",
  delete: "j5.skills.links.delete",
} as const;
const errors = Schema.Union([EnvironmentAuthorizationError, SkillLinkError]);
export const J5SkillLinkRpcGroup = RpcGroup.make(
  Rpc.make(J5_SKILL_LINK_WS_METHODS.deletePreview, {
    payload: SkillLinkInspect,
    success: SkillDeletePreview,
    error: errors,
  }),
  Rpc.make(J5_SKILL_LINK_WS_METHODS.delete, {
    payload: SkillDelete,
    success: SkillLinkMutationResult,
    error: errors,
  }),
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
  Rpc.make(J5_SKILL_LINK_WS_METHODS.unlink, {
    payload: SkillLinkUnlinkBatch,
    success: SkillLinkUnlinkResult,
    error: errors,
  }),
  Rpc.make(J5_SKILL_LINK_WS_METHODS.inspect, {
    payload: SkillLinkInspect,
    success: Schema.Array(ExistingSkillLink),
    error: errors,
  }),
);
