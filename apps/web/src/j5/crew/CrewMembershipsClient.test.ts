import { expect, it } from "@effect/vitest";

import { presentCrewMembership } from "./CrewMembershipsClient";

const live = { crewInstanceId: "crew:1", crewName: "Review Pair" };

it("labels members by seat and captains by the crews they command", () => {
  expect(presentCrewMembership(undefined)).toBeNull();
  expect(presentCrewMembership({ kind: "member", seat: "critic", crew: live })).toEqual({
    kind: "seat",
    label: "Review Pair · critic",
    title: "Seat critic of crew Review Pair",
  });
  expect(
    presentCrewMembership({
      kind: "captain",
      crews: [live, { crewInstanceId: "crew:2", crewName: "Second" }],
    }),
  ).toEqual({ kind: "captain", title: "Commands Review Pair, Second" });
  expect(presentCrewMembership({ kind: "captain", crews: [] })).toBeNull();
});
