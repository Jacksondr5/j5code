import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { makeCrewArchiveHttpRouteLayer } from "./CrewArchiveHttp.ts";
import { ArchiveCrewNotFoundError, ArchiveCrewService } from "./ArchiveCrewService.ts";
import { ParticipantId } from "./contracts.ts";

const path = "/raw/crews/archive";

const authWith = (scopes: ReadonlyArray<string>) =>
  Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: () =>
      Effect.succeed({
        sessionId: AuthSessionId.make("auth-session:crew-archive"),
        subject: "crew-archive-test",
        method: "bearer-access-token",
        scopes: scopes as never,
      }),
  });

it("archives a crew for operators only, with the person's confirmation already satisfied", async () => {
  const calls: Array<{
    callerParticipantId: unknown;
    squadronId: unknown;
    confirmationSatisfied: boolean | undefined;
    ids: string[];
  }> = [];
  const archives = Layer.mock(ArchiveCrewService)({
    archive: (input) => {
      calls.push({
        callerParticipantId: input.callerParticipantId,
        squadronId: input.squadronId,
        confirmationSatisfied: input.confirmationSatisfied,
        ids: ["builder", "critic"].map((seat) => input.commandIds(seat).archiveCommandId),
      });
      return input.crewInstanceId === "crew:1"
        ? Effect.succeed({
            status: "archived" as const,
            members: [
              {
                seatName: "builder",
                participantId: ParticipantId.make("agent:j5:a2a:thread:builder"),
                result: "archived" as const,
              },
              {
                seatName: "critic",
                participantId: ParticipantId.make("agent:j5:a2a:thread:critic"),
                result: "already_archived" as const,
              },
            ],
          })
        : Effect.fail(new ArchiveCrewNotFoundError({ crewInstanceId: input.crewInstanceId }));
    },
  });
  const routes = (scopes: ReadonlyArray<string>) =>
    makeCrewArchiveHttpRouteLayer(path).pipe(
      Layer.provide(archives),
      Layer.provideMerge(authWith(scopes)),
      Layer.provide(NodeServices.layer),
      Layer.provide(HttpServer.layerServices),
    );
  const operator = HttpRouter.toWebHandler(
    routes([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]),
    { disableLogger: true },
  );
  const reader = HttpRouter.toWebHandler(routes([AuthOrchestrationReadScope]), {
    disableLogger: true,
  });
  try {
    const archived = await operator.handler(
      new Request(`http://environment.test${path}`, {
        method: "POST",
        body: JSON.stringify({ crewInstanceId: "crew:1" }),
      }),
    );
    assert.equal(archived.status, 200);
    const body = (await archived.json()) as {
      status: string;
      members: Array<{ seat: string; result: string }>;
    };
    assert.equal(body.status, "archived");
    assert.deepStrictEqual(
      body.members.map((member) => [member.seat, member.result]),
      [
        ["builder", "archived"],
        ["critic", "already_archived"],
      ],
    );
    // A person is not a participant and confirmed the dialog: no Captain check, no token dance.
    assert.isNull(calls[0]?.callerParticipantId);
    assert.isNull(calls[0]?.squadronId);
    assert.isTrue(calls[0]?.confirmationSatisfied);
    assert.notEqual(calls[0]?.ids[0], calls[0]?.ids[1]);

    const missing = await operator.handler(
      new Request(`http://environment.test${path}`, {
        method: "POST",
        body: JSON.stringify({ crewInstanceId: "crew:nope" }),
      }),
    );
    assert.equal(missing.status, 404);

    const malformed = await operator.handler(
      new Request(`http://environment.test${path}`, { method: "POST", body: "{}" }),
    );
    assert.equal(malformed.status, 400);

    const forbidden = await reader.handler(
      new Request(`http://environment.test${path}`, {
        method: "POST",
        body: JSON.stringify({ crewInstanceId: "crew:1" }),
      }),
    );
    assert.equal(forbidden.status, 403);
    assert.lengthOf(calls, 2);
  } finally {
    await operator.dispose();
    await reader.dispose();
  }
});
