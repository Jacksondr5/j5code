import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

const scopedKey = (environmentId: EnvironmentId, id: string) => `${environmentId}\u0000${id}`;

/** The slice of upstream's logical project (a sidebar project snapshot) the J5 views need. */
export interface LogicalProjectGroup {
  readonly projectKey: string;
  readonly displayName: string;
  readonly memberProjects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
  }>;
}

/**
 * Resolves a J5 ledger row to upstream's logical project. A row with a thread names its project
 * directly; a row without one (a machine sender, an Inbox item) is reached through the project
 * its Squadron references. Returns undefined while the project or the Squadron directory has not
 * loaded, or when the project is gone, so the caller can fall back to what the read carries.
 */
export function createSquadronProjectLookup<Group extends LogicalProjectGroup>(input: {
  readonly groups: ReadonlyArray<Group>;
  readonly squadrons: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly squadron: { readonly id: string };
    readonly projectIds: ReadonlyArray<ProjectId>;
  }>;
}) {
  const groupByProject = new Map<string, Group>();
  for (const group of input.groups)
    for (const member of group.memberProjects)
      groupByProject.set(scopedKey(member.environmentId, member.id), group);
  const projectBySquadron = new Map<string, ProjectId>();
  for (const { environmentId, squadron, projectIds } of input.squadrons) {
    const projectId = projectIds[0];
    if (projectId !== undefined)
      projectBySquadron.set(scopedKey(environmentId, squadron.id), projectId);
  }
  const ofProject = (environmentId: EnvironmentId, projectId: ProjectId) =>
    groupByProject.get(scopedKey(environmentId, projectId));
  const ofSquadron = (environmentId: EnvironmentId, squadronId: string) => {
    const projectId = projectBySquadron.get(scopedKey(environmentId, squadronId));
    return projectId === undefined ? undefined : ofProject(environmentId, projectId);
  };
  return { ofProject, ofSquadron };
}
