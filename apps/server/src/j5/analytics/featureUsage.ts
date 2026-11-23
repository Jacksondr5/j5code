import {
  J5_ARTIFACT_WS_METHODS,
  J5_SKILL_CATALOG_WS_METHODS,
  J5_SKILL_LINK_WS_METHODS,
  ORCHESTRATION_V2_WS_METHODS,
  ProviderApprovalDecision,
  SkillLinkRequest,
} from "@t3tools/contracts";
import {
  J5_ACCESS_WS_METHODS,
  J5_CLIENT_ACTION_WS_METHODS,
  J5_PEOPLE_WS_METHODS,
  PersonLevel,
} from "@t3tools/contracts/j5";
import * as Schema from "effect/Schema";

import type { FeatureUsage } from "../../telemetry/FeatureUsage.ts";

type Payload = Readonly<Record<string, unknown>>;

/** A variant only when the payload's value is one of the contract's literals. */
const variant =
  <A extends string>(schema: Schema.Schema<A>) =>
  (feature: string, value: unknown): FeatureUsage => {
    const is = Schema.is(schema);
    return is(value) ? { feature, variant: value } : { feature };
  };

const approvalDecision = variant(ProviderApprovalDecision);
const level = variant(PersonLevel);
const skillScope = variant(SkillLinkRequest.fields.scope);

/**
 * J5's person actions for upstream's `feature.used`, consulted after upstream's own table in
 * `telemetry/FeatureUsage.ts` (FORK.md). Variants come only from closed contract enums. Crew
 * proposal decisions are recorded by `CrewProposalService`, which alone knows an edited roster;
 * playbook start and cancel have no client RPC, so `mcp.tool.invoked` counts them.
 */
export const J5_METHOD_FEATURES: Readonly<
  Record<string, (payload: Payload) => FeatureUsage | undefined>
> = {
  [J5_CLIENT_ACTION_WS_METHODS.answerHumanExchange]: () => ({ feature: "inbox.reply" }),
  [J5_CLIENT_ACTION_WS_METHODS.respondCrewRuntimeRequest]: (payload) =>
    approvalDecision("inbox.approval", payload.decision),
  // Upstream leaves launches to `client.thread.started`; choosing a persona is the feature here.
  [ORCHESTRATION_V2_WS_METHODS.launchThread]: (payload) =>
    payload.agentPersona === undefined ? undefined : { feature: "persona.assign" },
  [J5_SKILL_CATALOG_WS_METHODS.applySkillCatalogGroups]: () => ({ feature: "skill.install" }),
  [J5_SKILL_CATALOG_WS_METHODS.updateSkillCatalog]: () => ({ feature: "skill.update" }),
  [J5_SKILL_LINK_WS_METHODS.create]: (payload) => skillScope("skill.link", payload.scope),
  // Unlinking one managed link by id, or a batch found on disk: the same action to a person.
  [J5_SKILL_LINK_WS_METHODS.remove]: () => ({ feature: "skill.unlink" }),
  [J5_SKILL_LINK_WS_METHODS.unlink]: () => ({ feature: "skill.unlink" }),
  [J5_SKILL_LINK_WS_METHODS.delete]: () => ({ feature: "skill.delete" }),
  [J5_ARTIFACT_WS_METHODS.deleteArtifact]: () => ({ feature: "artifact.delete" }),
  [J5_ARTIFACT_WS_METHODS.deleteAllArtifacts]: () => ({ feature: "artifact.delete_all" }),
  [J5_PEOPLE_WS_METHODS.createLink]: (payload) =>
    payload.kind === "device"
      ? { feature: "sharing.device_link.create" }
      : level("sharing.invite.create", payload.level),
  [J5_PEOPLE_WS_METHODS.revokeLink]: () => ({ feature: "sharing.link.revoke" }),
  [J5_PEOPLE_WS_METHODS.setLevel]: (payload) => level("sharing.level.set", payload.level),
  [J5_PEOPLE_WS_METHODS.removeLevel]: () => ({ feature: "sharing.level.remove" }),
  [J5_PEOPLE_WS_METHODS.removePerson]: () => ({ feature: "sharing.person.remove" }),
  [J5_PEOPLE_WS_METHODS.revokeDevice]: () => ({ feature: "sharing.device.revoke" }),
  [J5_ACCESS_WS_METHODS.leave]: () => ({ feature: "sharing.leave" }),
};
