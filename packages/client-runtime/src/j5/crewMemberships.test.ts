import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ThreadCrewMembership } from "@t3tools/contracts/j5";
import { expect, it } from "vite-plus/test";

import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";
import { replaceCrewMemberships } from "./crewMemberships.ts";

const live = { crewInstanceId: "crew:1", crewName: "Review Pair" };

it("treats the visible rows as the whole truth when replacing memberships, per environment", () => {
  const environmentId = EnvironmentId.make("env:a");
  const other = EnvironmentId.make("env:b");
  const key = (id: string, env = environmentId) =>
    scopedThreadKey(scopeThreadRef(env, ThreadId.make(id)));
  const stale = ThreadId.make("thread:stale");
  const fresh = ThreadId.make("thread:fresh");
  const membership: ThreadCrewMembership = { kind: "member", seat: "builder", crew: live };
  const previous = new Map<string, ThreadCrewMembership>([
    [key("thread:stale"), membership],
    [key("thread:kept"), membership],
    // The same local id on another environment is a different thread and stays untouched.
    [key("thread:stale", other), membership],
  ]);
  const next = replaceCrewMemberships(
    previous,
    environmentId,
    [stale, fresh],
    [{ threadId: fresh, membership: { kind: "captain", crews: [live] } }],
  );
  expect([...next.keys()].toSorted()).toEqual(
    [key("thread:fresh"), key("thread:kept"), key("thread:stale", other)].toSorted(),
  );
  expect(previous.size).toBe(3);
});
