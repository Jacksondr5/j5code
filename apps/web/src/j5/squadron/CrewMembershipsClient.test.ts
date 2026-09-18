import { expect, it } from "@effect/vitest";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  presentCrewMembership,
  replaceCrewMemberships,
  type ThreadCrewMembership,
} from "./CrewMembershipsClient";

const live = {
  crewInstanceId: "crew:1",
  crewName: "Review Pair",
  archived: false,
};

it("labels members by seat and captains by their live crews", () => {
  expect(presentCrewMembership(undefined)).toBeNull();
  expect(presentCrewMembership({ kind: "member", seat: "critic", crew: live })).toEqual({
    kind: "seat",
    label: "Review Pair · critic",
    title: "Seat critic of crew Review Pair",
  });
  expect(
    presentCrewMembership({ kind: "member", seat: "critic", crew: { ...live, archived: true } }),
  ).toBeNull();
  expect(
    presentCrewMembership({
      kind: "captain",
      crews: [live, { ...live, crewInstanceId: "crew:2", crewName: "Old", archived: true }],
    }),
  ).toEqual({ kind: "captain", title: "Commands Review Pair" });
  expect(
    presentCrewMembership({ kind: "captain", crews: [{ ...live, archived: true }] }),
  ).toBeNull();
});

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
