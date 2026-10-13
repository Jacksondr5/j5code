import type { ProjectId, ThreadId } from "@t3tools/contracts";
import type { SharingGrant, SharingPerson } from "@t3tools/contracts/j5";

export interface Holder {
  readonly person: SharingPerson;
  readonly grant: SharingGrant;
}

/** Everyone who reaches one thread, by how they reach it. */
export interface ThreadPeople {
  /** Guests whose grant is on this thread itself. */
  readonly direct: ReadonlyArray<Holder>;
  /** Guests who reach it through a grant on its project. */
  readonly throughProject: ReadonlyArray<Holder>;
  /** Members reach every thread and hold no level. */
  readonly members: ReadonlyArray<SharingPerson>;
}

/**
 * Who reaches a thread, worked out from the server's list of people. It sees grants on the thread
 * and on its project. It does not see a grant on a thread this one works for, an agent's parent:
 * that takes the server's own answer for the thread.
 */
export function threadPeopleFrom(
  people: ReadonlyArray<SharingPerson>,
  thread: { readonly threadId: ThreadId; readonly projectId: ProjectId | null },
): ThreadPeople {
  const direct: Holder[] = [];
  const throughProject: Holder[] = [];
  const members: SharingPerson[] = [];
  for (const person of people) {
    if (person.kind === "member") {
      members.push(person);
      continue;
    }
    const onThread = person.grants.find(
      (grant) => grant.target.kind === "thread" && grant.target.threadId === thread.threadId,
    );
    if (onThread !== undefined) {
      direct.push({ person, grant: onThread });
      continue;
    }
    const onProject = person.grants.find(
      (grant) => grant.target.kind === "project" && grant.target.projectId === thread.projectId,
    );
    if (onProject !== undefined) throughProject.push({ person, grant: onProject });
  }
  return { direct, throughProject, members };
}

/** The guests a thread is shared with; a thread only members reach is not shared. */
export const sharedWith = (people: ThreadPeople): ReadonlyArray<Holder> => [
  ...people.direct,
  ...people.throughProject,
];

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 people", for the header chip; `null` when the thread is not shared and shows no chip. */
export function chipLabel(people: ThreadPeople): string | null {
  const shared = sharedWith(people).length;
  return shared === 0 ? null : count(shared, "person", "people");
}

/** "3 others", everyone who reaches the thread without a grant on it; `null` when there is no one. */
export function othersLabel(people: ThreadPeople): string | null {
  const others = people.members.length + people.throughProject.length;
  return others === 0 ? null : count(others, "other", "others");
}
