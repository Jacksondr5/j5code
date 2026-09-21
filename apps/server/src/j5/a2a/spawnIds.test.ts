import { describe, expect, it } from "vite-plus/test";

import { crewSeatRequestKey, spawnThreadId } from "./spawnIds.ts";

describe("spawn thread ids", () => {
  it("keeps terminal history filenames bounded and retries deterministic", () => {
    const input = {
      providerSessionId: "j5-crew-proposal",
      requestKey: crewSeatRequestKey("crew:" + "long%3Aproposal/".repeat(200), "reviewer"),
    };
    const id = spawnThreadId(input);
    expect(spawnThreadId(input)).toBe(id);
    expect(Buffer.byteLength(`terminal_${Buffer.from(id).toString("base64url")}.log`)).toBeLessThan(
      255,
    );
    expect(spawnThreadId({ ...input, requestKey: input.requestKey + "-2" })).not.toBe(id);
    expect(spawnThreadId({ ...input, providerSessionId: "another-session" })).not.toBe(id);
    expect(spawnThreadId({ providerSessionId: "a:b", requestKey: "c" })).not.toBe(
      spawnThreadId({ providerSessionId: "a", requestKey: "b:c" }),
    );
  });
});

import { assert } from "@effect/vitest";

import {
  spawnBriefWithoutCrewContext,
  spawnFirstTurnText,
  type CrewBriefContext,
} from "./spawnIds.ts";

const identity = {
  brief: "Review the proposed change.",
  participantId: "agent:reviewer",
  squadronId: "squadron:review",
  squadronName: "Review",
};
const crew: CrewBriefContext = {
  displayName: "Change review",
  instanceId: "crew:review",
  seatName: "reviewer",
  captainParticipantId: "agent:captain",
  seatInstructions: "Review correctness and report concrete risks.",
  roster: [
    { seat: "reviewer", participantId: identity.participantId, agentDisplayName: "custom" },
    { seat: "builder", participantId: "agent:builder", agentDisplayName: "Builder" },
  ],
};

it("gives custom seats direct result and concern reporting without a mandatory artifact", () => {
  const text = spawnFirstTurnText({ ...identity, crew });
  assert.include(text, "captain_participant_id: agent:captain");
  assert.include(text, "- builder: participant_id=agent:builder");
  assert.include(
    text,
    "use send_message to coordinate directly with your Captain and other members",
  );
  assert.include(text, "final result, supporting evidence, and any remaining blockers");
  assert.include(text, "request_crew_member through the user's inbox");
  assert.include(text, "Continue already-approved work and coordination");
  assert.include(text, "A direct result is sufficient");
  assert.include(text, `<seat_instructions>\n${crew.seatInstructions}\n</seat_instructions>`);
  assert.notInclude(text, "<seat_obligation>");
  assert.notInclude(text, "write_artifact");
});

it("retains declared persona output while allowing conversation before that output exists", () => {
  const text = spawnFirstTurnText({
    ...identity,
    crew: { ...crew, obligation: { kind: "ReviewHandoff", path: "handoffs/review.md" } },
  });
  assert.include(text, "do not wait for an artifact or coordination approval");
  assert.include(text, "write_artifact to exactly `handoffs/review.md`");
  assert.include(text, "must not delay sharing intermediate findings or results");
  assert.notInclude(text, "a chat message is not a delivery");
});

it("keeps an ordinary Peer Agent brief free of crew instructions", () => {
  const text = spawnFirstTurnText(identity);
  assert.include(text, `<spawner_brief>\n${identity.brief}\n</spawner_brief>`);
  assert.notInclude(text, "crew_collaboration");
  assert.notInclude(text, "Captain");
});

it("compares dispatched briefs by their human-authored parts, not the roster", () => {
  const first = spawnFirstTurnText({ ...identity, crew });
  const smallerRoster = spawnFirstTurnText({
    ...identity,
    crew: { ...crew, roster: crew.roster.slice(0, 1) },
  });
  assert.notEqual(first, smallerRoster);
  assert.equal(spawnBriefWithoutCrewContext(first), spawnBriefWithoutCrewContext(smallerRoster));
  assert.notEqual(
    spawnBriefWithoutCrewContext(first),
    spawnBriefWithoutCrewContext(
      spawnFirstTurnText({ ...identity, crew: { ...crew, seatInstructions: "Edited" } }),
    ),
  );
  assert.notEqual(
    spawnBriefWithoutCrewContext(first),
    spawnBriefWithoutCrewContext(spawnFirstTurnText({ ...identity, brief: "Edited", crew })),
  );
  assert.notInclude(spawnBriefWithoutCrewContext(first), "j5_crew_context");
  assert.include(spawnBriefWithoutCrewContext(first), "<seat_instructions>");
});
