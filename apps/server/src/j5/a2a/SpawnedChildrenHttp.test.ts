import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";

import type { AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { projectSpawnedChildren, threadIdForParticipant } from "./SpawnedChildrenHttp.ts";
import { ParticipantId, SquadronId } from "./contracts.ts";

const captainThread = ThreadId.make("thread:captain");
const builderThread = ThreadId.make("thread:builder");
const helperThread = ThreadId.make("thread:helper");
const captain = participantIdForThread(captainThread);
const builder = participantIdForThread(builderThread);
const helper = participantIdForThread(helperThread);

const crew: AgentCrewInstance = {
  id: "crew:1",
  squadronId: SquadronId.make("squadron:children"),
  captainParticipantId: captain,
  captainThreadId: captainThread,
  brief: "Implement and review the login fix.",
  version: 1,
  displayName: "Review Pair",
  createdAt: "2026-09-09T16:00:00.000Z",
  archivedAt: null,
  members: [
    {
      seatName: "builder",
      agentId: "builder",
      participantId: builder,
      threadId: builderThread,
      addedVersion: 1,
      reason: null,
    },
  ],
};

it("maps participant ids back to thread ids only for agent participants", () => {
  assert.equal(threadIdForParticipant(builder), builderThread);
  assert.isNull(threadIdForParticipant(ParticipantId.make("human:bryant")));
});

it("groups placed children under each visible thread and marks live crew seats", () => {
  const projected = projectSpawnedChildren(
    [captainThread, helperThread, captainThread],
    [
      { participant_id: builder, placement_parent_id: captain },
      { participant_id: helper, placement_parent_id: captain },
      { participant_id: "human:bryant", placement_parent_id: captain },
      {
        participant_id: participantIdForThread(ThreadId.make("thread:grandchild")),
        placement_parent_id: helper,
      },
    ],
    [crew, { ...crew, id: "crew:old", archivedAt: "2026-09-09T18:00:00.000Z" }],
  );
  assert.deepStrictEqual(projected.entries, [
    {
      threadId: captainThread,
      children: [
        {
          threadId: builderThread,
          participantId: builder,
          seat: { crewInstanceId: "crew:1", crewName: "Review Pair", seat: "builder" },
        },
        { threadId: helperThread, participantId: helper, seat: null },
      ],
    },
    {
      threadId: helperThread,
      children: [
        {
          threadId: ThreadId.make("thread:grandchild"),
          participantId: participantIdForThread(ThreadId.make("thread:grandchild")),
          seat: null,
        },
      ],
    },
  ]);
});
