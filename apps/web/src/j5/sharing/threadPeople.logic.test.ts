import type { ProjectId, ThreadId } from "@t3tools/contracts";
import type { SharingPerson } from "@t3tools/contracts/j5";
import { describe, expect, it } from "vite-plus/test";

import { chipLabel, othersLabel, threadPeopleFrom } from "./threadPeople.logic";

const person = (personId: string, grants: ReadonlyArray<unknown>, kind = "guest") =>
  ({ personId, kind, displayName: personId, nameSelfGiven: false, grants }) as SharingPerson;
const onThread = (threadId: string, level = "view") => ({
  target: { kind: "thread", threadId },
  level,
});
const onProject = (projectId: string, level = "view") => ({
  target: { kind: "project", projectId },
  level,
});
const thread = { threadId: "t1" as ThreadId, projectId: "p1" as ProjectId };

describe("who reaches a thread", () => {
  const people = [
    person("member", [], "member"),
    person("direct", [onThread("t1", "collaborate")]),
    person("both", [onProject("p1"), onThread("t1")]),
    person("project", [onProject("p1")]),
    person("elsewhere", [onThread("t2"), onProject("p2")]),
  ];
  const reached = threadPeopleFrom(people, thread);

  it("puts a grant on the thread before one on its project, and lists a person once", () => {
    expect(reached.direct.map((held) => held.person.personId)).toEqual(["direct", "both"]);
    expect(reached.throughProject.map((held) => held.person.personId)).toEqual(["project"]);
    expect(reached.members.map((member) => member.personId)).toEqual(["member"]);
  });

  it("counts guests for the chip, and members and project guests as the others", () => {
    expect(chipLabel(reached)).toBe("3 people");
    expect(othersLabel(reached)).toBe("2 others");
  });

  it("shows no chip for a thread only members reach", () => {
    const membersOnly = threadPeopleFrom([person("member", [], "member")], thread);
    expect(chipLabel(membersOnly)).toBeNull();
    expect(othersLabel(membersOnly)).toBe("1 other");
  });
});
