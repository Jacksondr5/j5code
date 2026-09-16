import { AuthOrchestrationReadScope, AuthSessionId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { AgentCrewInstanceService, type AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import { makeAgentCrewReadsHttpRouteLayer, projectCrewMemberships } from "./AgentCrewReadsHttp.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { ParticipantId, SquadronId } from "./contracts.ts";

const captainThread = ThreadId.make("thread:captain");
const builderThread = ThreadId.make("thread:builder");
const criticThread = ThreadId.make("thread:critic");
const instance = (id: string, archivedAt: string | null): AgentCrewInstance => ({
  id,
  squadronId: SquadronId.make("squadron:crew-reads"),
  captainParticipantId: participantIdForThread(captainThread),
  captainThreadId: captainThread,
  brief: "Implement and review the login fix.",
  version: 1,
  displayName: "Review Pair",
  createdAt: "2026-09-09T16:00:00.000Z",
  archivedAt,
  members: [
    {
      seatName: "builder",
      agentId: "builder",
      participantId: participantIdForThread(builderThread),
      threadId: builderThread,
      addedVersion: 1,
      reason: null,
    },
    {
      seatName: "critic",
      agentId: "critic",
      participantId: participantIdForThread(criticThread),
      threadId: criticThread,
      addedVersion: 1,
      reason: null,
    },
  ],
});

it("projects one membership per involved thread, members before captains, nothing for outsiders", () => {
  const outsider = ThreadId.make("thread:outsider");
  const projected = projectCrewMemberships(
    [captainThread, builderThread, outsider, builderThread],
    [instance("crew:live", null), instance("crew:old", "2026-09-09T17:00:00.000Z")],
  );
  assert.deepStrictEqual(projected.entries, [
    {
      threadId: captainThread,
      membership: {
        kind: "captain",
        crews: [
          {
            crewInstanceId: "crew:live",
            crewName: "Review Pair",
            archived: false,
          },
          {
            crewInstanceId: "crew:old",
            crewName: "Review Pair",
            archived: true,
          },
        ],
      },
    },
    {
      threadId: builderThread,
      membership: {
        kind: "member",
        seat: "builder",
        crew: {
          crewInstanceId: "crew:old",
          crewName: "Review Pair",
          archived: true,
        },
      },
    },
  ]);
});

it("serves the authenticated crew-membership read from the visible thread ids", async () => {
  const received: Array<{
    threadIds: ReadonlyArray<ThreadId>;
    participantIds: ReadonlyArray<ParticipantId>;
  }> = [];
  const crews = Layer.mock(AgentCrewInstanceService)({
    listInvolving: (input) => {
      received.push(input);
      return Effect.succeed([instance("crew:live", null)]);
    },
  });
  const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: () =>
      Effect.succeed({
        sessionId: AuthSessionId.make("auth-session:crew-reads"),
        subject: "crew-reads-test",
        method: "bearer-access-token",
        scopes: [AuthOrchestrationReadScope],
      }),
  });
  const routes = makeAgentCrewReadsHttpRouteLayer("/raw/crew-memberships").pipe(
    Layer.provide(crews),
    Layer.provideMerge(auth),
    Layer.provide(HttpServer.layerServices),
  );
  const { dispose, handler } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  try {
    const response = await handler(
      new Request("http://environment.test/raw/crew-memberships", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadIds: [criticThread, captainThread] }),
      }),
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      entries: Array<{ threadId: string; membership: { kind: string } }>;
    };
    assert.deepStrictEqual(
      body.entries.map((entry) => [entry.threadId, entry.membership.kind]),
      [
        [criticThread, "member"],
        [captainThread, "captain"],
      ],
    );
    assert.deepStrictEqual(received[0]?.threadIds, [criticThread, captainThread]);
    assert.deepStrictEqual(received[0]?.participantIds, [
      participantIdForThread(criticThread),
      participantIdForThread(captainThread),
    ]);

    const invalid = await handler(
      new Request("http://environment.test/raw/crew-memberships", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadIds: "nope" }),
      }),
    );
    assert.equal(invalid.status, 400);
  } finally {
    await dispose();
  }
});
