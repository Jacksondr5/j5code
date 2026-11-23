import {
  J5_ARTIFACT_WS_METHODS,
  J5_SKILL_CATALOG_WS_METHODS,
  J5_SKILL_LINK_WS_METHODS,
  ORCHESTRATION_V2_WS_METHODS,
} from "@t3tools/contracts";
import {
  J5_ACCESS_WS_METHODS,
  J5_CLIENT_ACTION_WS_METHODS,
  J5_PEOPLE_WS_METHODS,
} from "@t3tools/contracts/j5";
import { expect, it } from "@effect/vitest";

import { featureUsage } from "../../telemetry/FeatureUsage.ts";

const secret = "Private title /home/someone/secret";

it("counts each J5 person action as its feature, with its enum variant", () => {
  const cases: ReadonlyArray<readonly [string, object, object]> = [
    [
      J5_CLIENT_ACTION_WS_METHODS.answerHumanExchange,
      { exchangeId: "exchange-private", message: secret, clientRequestId: "request-private" },
      { feature: "inbox.reply" },
    ],
    [
      J5_CLIENT_ACTION_WS_METHODS.respondCrewRuntimeRequest,
      { threadId: "thread-private", requestId: "request-private", decision: "acceptForSession" },
      { feature: "inbox.approval", variant: "acceptForSession" },
    ],
    [
      ORCHESTRATION_V2_WS_METHODS.launchThread,
      { title: secret, agentPersona: { personaId: "reviewer-private" } },
      { feature: "persona.assign" },
    ],
    [
      J5_SKILL_CATALOG_WS_METHODS.applySkillCatalogGroups,
      { expectedSource: secret, groups: ["private-group"] },
      { feature: "skill.install" },
    ],
    [
      J5_SKILL_CATALOG_WS_METHODS.updateSkillCatalog,
      { expectedSource: secret },
      { feature: "skill.update" },
    ],
    [
      J5_SKILL_LINK_WS_METHODS.create,
      { source: { path: secret, name: secret }, scope: "project" },
      { feature: "skill.link", variant: "project" },
    ],
    [J5_SKILL_LINK_WS_METHODS.remove, { id: "link-private" }, { feature: "skill.unlink" }],
    [J5_SKILL_LINK_WS_METHODS.unlink, { links: [] }, { feature: "skill.unlink" }],
    [J5_SKILL_LINK_WS_METHODS.delete, { path: secret }, { feature: "skill.delete" }],
    [
      J5_ARTIFACT_WS_METHODS.deleteArtifact,
      { projectId: "project-private", path: secret },
      { feature: "artifact.delete" },
    ],
    [
      J5_ARTIFACT_WS_METHODS.deleteAllArtifacts,
      { projectId: "project-private" },
      { feature: "artifact.delete_all" },
    ],
    [
      J5_PEOPLE_WS_METHODS.createLink,
      {
        kind: "invite",
        scope: { kind: "server" },
        level: "collaborator",
        use: "one",
        name: secret,
      },
      { feature: "sharing.invite.create", variant: "collaborator" },
    ],
    [
      J5_PEOPLE_WS_METHODS.createLink,
      { kind: "device", personId: "person-private" },
      { feature: "sharing.device_link.create" },
    ],
    [
      J5_PEOPLE_WS_METHODS.revokeLink,
      { linkId: "link-private" },
      { feature: "sharing.link.revoke" },
    ],
    [
      J5_PEOPLE_WS_METHODS.setLevel,
      { personId: "person-private", scope: { kind: "server" }, level: "viewer" },
      { feature: "sharing.level.set", variant: "viewer" },
    ],
    [
      J5_PEOPLE_WS_METHODS.removeLevel,
      { personId: "person-private", scope: { kind: "server" } },
      { feature: "sharing.level.remove" },
    ],
    [
      J5_PEOPLE_WS_METHODS.removePerson,
      { personId: "person-private" },
      { feature: "sharing.person.remove" },
    ],
    [
      J5_PEOPLE_WS_METHODS.revokeDevice,
      { sessionId: "session-private" },
      { feature: "sharing.device.revoke" },
    ],
    [J5_ACCESS_WS_METHODS.leave, {}, { feature: "sharing.leave" }],
  ];
  for (const [method, payload, usage] of cases) {
    expect(featureUsage(method, payload), method).toEqual(usage);
  }
});

it("never turns free text in a variant's field into a variant", () => {
  expect(featureUsage(J5_PEOPLE_WS_METHODS.setLevel, { personId: "p", level: secret })).toEqual({
    feature: "sharing.level.set",
  });
  expect(
    featureUsage(J5_CLIENT_ACTION_WS_METHODS.respondCrewRuntimeRequest, { decision: secret }),
  ).toEqual({ feature: "inbox.approval" });
  expect(featureUsage(J5_SKILL_LINK_WS_METHODS.create, { scope: secret })).toEqual({
    feature: "skill.link",
  });
});

it("leaves plain launches, Crew decisions, and reads uncounted", () => {
  // A launch without a persona stays with upstream's `client.thread.started`.
  expect(featureUsage(ORCHESTRATION_V2_WS_METHODS.launchThread, { title: secret })).toBe(undefined);
  // `CrewProposalService` records the decision, as only it can tell an edited roster.
  expect(
    featureUsage(J5_CLIENT_ACTION_WS_METHODS.resolveCrewProposal, {
      proposalId: "proposal-private",
      decision: "decline",
    }),
  ).toBe(undefined);
  expect(featureUsage(J5_PEOPLE_WS_METHODS.listPeople, {})).toBe(undefined);
});
