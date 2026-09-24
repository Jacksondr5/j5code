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
import { makeCrewStopHttpRouteLayer } from "./CrewStopHttp.ts";
import { CrewStopNotFoundError, CrewStopService } from "./CrewStopService.ts";
import { ParticipantId } from "./contracts.ts";

const path = "/raw/crews/stop";

const authWith = (scopes: ReadonlyArray<string>) =>
  Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: () =>
      Effect.succeed({
        sessionId: AuthSessionId.make("auth-session:crew-stop"),
        subject: "crew-stop-test",
        method: "bearer-access-token",
        scopes: scopes as never,
      }),
  });

it("stops a crew for operators only and reports each seat", async () => {
  const calls: Array<{ callerParticipantId: unknown; crewInstanceId: string; ids: string[] }> = [];
  const stops = Layer.mock(CrewStopService)({
    stop: (input) => {
      calls.push({
        callerParticipantId: input.callerParticipantId,
        crewInstanceId: input.crewInstanceId,
        ids: ["builder", "critic"].map((seat) => input.commandIds(seat).interruptCommandId),
      });
      return input.crewInstanceId === "crew:1"
        ? Effect.succeed({
            crewInstanceId: "crew:1",
            members: [
              {
                seatName: "builder",
                participantId: ParticipantId.make("agent:j5:a2a:thread:builder"),
                result: "interrupt_requested" as const,
              },
              {
                seatName: "critic",
                participantId: ParticipantId.make("agent:j5:a2a:thread:critic"),
                result: "already_idle" as const,
              },
              {
                seatName: "ghost",
                participantId: ParticipantId.make("agent:j5:a2a:thread:ghost"),
                result: "never_created" as const,
              },
            ],
          })
        : Effect.fail(new CrewStopNotFoundError({ crewInstanceId: input.crewInstanceId }));
    },
  });
  const routes = (scopes: ReadonlyArray<string>) =>
    makeCrewStopHttpRouteLayer(path).pipe(
      Layer.provide(stops),
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
    const stopped = await operator.handler(
      new Request(`http://environment.test${path}`, {
        method: "POST",
        body: JSON.stringify({ crewInstanceId: "crew:1" }),
      }),
    );
    assert.equal(stopped.status, 200);
    const body = (await stopped.json()) as { members: Array<{ seat: string; result: string }> };
    assert.deepStrictEqual(
      body.members.map((member) => [member.seat, member.result]),
      [
        ["builder", "interrupt_requested"],
        ["critic", "already_idle"],
      ],
    );
    // A never-created seat rides its own optional field, so a client that predates it still
    // decodes every member it knows.
    assert.deepStrictEqual((body as { neverCreatedSeats?: unknown }).neverCreatedSeats, ["ghost"]);
    // A person is not a participant: no Captain check, and per-seat ids differ per seat.
    assert.isNull(calls[0]?.callerParticipantId);
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
