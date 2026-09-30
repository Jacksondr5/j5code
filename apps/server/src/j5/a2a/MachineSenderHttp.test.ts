import {
  AuthA2APeerScope,
  AuthA2ASendScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import { J5_MACHINE_API_PATHS } from "@t3tools/contracts/j5";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { A2ADeliveryWorker } from "./DeliveryWorker.ts";
import {
  MachineParticipantNotFoundError,
  MachineParticipantService,
  type MachineParticipantRecord,
} from "./MachineParticipantService.ts";
import { machineSendCommandId, machineSenderHttpRouteLayer } from "./MachineSenderHttp.ts";
import { RosterService } from "./RosterService.ts";
import { A2AMachineCannotReceiveError, A2ASendService } from "./SendService.ts";
import {
  LedgerMessageId,
  ParticipantId,
  type SendAsMachineInput,
  SquadronId,
} from "./contracts.ts";

const watchdog: MachineParticipantRecord = {
  participantId: ParticipantId.make("machine:watchdog"),
  squadronId: SquadronId.make("squadron:monitoring"),
  squadronName: "Monitoring",
  name: "watchdog",
  createdAt: "2026-09-15T00:00:00.000Z",
};
const sentinelId = ParticipantId.make("agent:j5:a2a:thread:sentinel");

const makeHandler = (input: {
  readonly subject: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly sends?: Array<SendAsMachineInput>;
  readonly notifications?: { count: number };
}) => {
  const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: () =>
      Effect.succeed({
        sessionId: AuthSessionId.make("auth-session:machine-http"),
        subject: input.subject,
        method: "bearer-access-token",
        scopes: input.scopes,
      }),
  });
  const routes = machineSenderHttpRouteLayer.pipe(
    Layer.provide(
      Layer.mock(MachineParticipantService)({
        resolve: (participantId) =>
          participantId === watchdog.participantId
            ? Effect.succeed(watchdog)
            : Effect.fail(new MachineParticipantNotFoundError({ participantId })),
        register: (registration) =>
          Effect.succeed({
            participant: { ...watchdog, name: registration.name },
            created: true,
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(A2ASendService)({
        sendAsMachine: (send) =>
          send.to.startsWith("machine:")
            ? Effect.fail(new A2AMachineCannotReceiveError({ participantId: send.to }))
            : Effect.sync(() => {
                input.sends?.push(send);
                return {
                  messageId: LedgerMessageId.make("message:j5:a2a:one"),
                  exchangeId: null,
                  exchangeState: "none" as const,
                  joinedExistingExchange: false,
                  durableAtSeq: 7,
                };
              }),
      }),
    ),
    Layer.provide(
      Layer.mock(A2ADeliveryWorker)({
        notify: Effect.sync(() => {
          if (input.notifications) input.notifications.count += 1;
        }),
      }),
    ),
    Layer.provide(
      Layer.mock(RosterService)({
        list: () => Effect.succeed([]),
        resolveRecipient: (to) =>
          Effect.succeed(
            to === "obs-sentinel"
              ? { kind: "resolved" as const, participantId: sentinelId }
              : to.includes(":")
                ? { kind: "resolved" as const, participantId: ParticipantId.make(to) }
                : to === "twin"
                  ? {
                      kind: "ambiguous" as const,
                      candidates: [
                        {
                          participantId: "agent:j5:a2a:thread:twin-one",
                          kind: "agent" as const,
                          squadronId: "squadron:monitoring",
                          squadronName: "Monitoring",
                          displayName: "twin",
                          threadId: null,
                          archived: false,
                          canReceiveMessage: true,
                          acceptsUrgency: false,
                          liveness: null,
                        },
                        {
                          participantId: "agent:j5:a2a:thread:twin-two",
                          kind: "agent" as const,
                          squadronId: "squadron:monitoring",
                          squadronName: "Monitoring",
                          displayName: "twin",
                          threadId: null,
                          archived: false,
                          canReceiveMessage: true,
                          acceptsUrgency: false,
                          liveness: null,
                        },
                      ],
                    }
                  : { kind: "not_found" as const },
          ),
      }),
    ),
    Layer.provideMerge(auth),
    Layer.provide(HttpServer.layerServices),
  );
  return HttpRouter.toWebHandler(routes, { disableLogger: true });
};

const post = (path: string, body: unknown) =>
  new Request(`http://environment.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const get = (path: string) => new Request(`http://environment.test${path}`);

it("sends as the token's machine subject with the MCP-shaped command id and wakes the worker", async () => {
  const sends: Array<SendAsMachineInput> = [];
  const notifications = { count: 0 };
  const { dispose, handler } = makeHandler({
    subject: watchdog.participantId,
    scopes: [AuthA2ASendScope],
    sends,
    notifications,
  });
  try {
    const response = await handler(
      post(J5_MACHINE_API_PATHS.send, {
        to: "obs-sentinel",
        message: "canary 42",
        clientRequestId: "canary-42",
      }),
    );
    assert.equal(response.status, 200);
    assert.deepStrictEqual(await response.json(), {
      sender: watchdog.participantId,
      receiver: sentinelId,
      result: {
        messageId: "message:j5:a2a:one",
        exchangeId: null,
        exchangeState: "none",
        joinedExistingExchange: false,
        durableAtSeq: 7,
      },
    });
    assert.equal(sends.length, 1);
    assert.equal(
      sends[0]!.commandId,
      machineSendCommandId({
        senderParticipantId: watchdog.participantId,
        clientRequestId: "canary-42",
      }),
    );
    assert.equal(sends[0]!.senderParticipantId, watchdog.participantId);
    assert.equal(notifications.count, 1);
  } finally {
    await dispose();
  }
});

it("refuses a token without a2a:send, a non-machine subject, and an unregistered machine", async () => {
  const cases = [
    { subject: watchdog.participantId, scopes: [AuthOrchestrationOperateScope], error: null },
    { subject: "deploy-bot", scopes: [AuthA2ASendScope], error: "machine_subject_required" },
    {
      subject: "machine:ghost",
      scopes: [AuthA2ASendScope],
      error: "machine_sender_not_registered",
    },
  ] as const;
  for (const testCase of cases) {
    const { dispose, handler } = makeHandler({
      subject: testCase.subject,
      scopes: testCase.scopes,
    });
    try {
      const response = await handler(
        post(J5_MACHINE_API_PATHS.send, { to: "obs-sentinel", message: "x", clientRequestId: "r" }),
      );
      assert.equal(response.status, 403, testCase.subject);
      const body = (await response.json()) as { readonly error?: string };
      if (testCase.error !== null) assert.equal(body.error, testCase.error);
      else assert.notEqual(body.error, "policy_refused");
      const whoami = await handler(get(J5_MACHINE_API_PATHS.whoami));
      assert.equal(whoami.status, 403, `${testCase.subject} whoami`);
    } finally {
      await dispose();
    }
  }
});

it("maps recipient outcomes: unknown to 404, ambiguous to 409 with candidates, policy to 403", async () => {
  const { dispose, handler } = makeHandler({
    subject: watchdog.participantId,
    scopes: [AuthA2ASendScope],
    sends: [],
  });
  try {
    const unknown = await handler(
      post(J5_MACHINE_API_PATHS.send, { to: "nobody", message: "x", clientRequestId: "r1" }),
    );
    assert.equal(unknown.status, 404);
    assert.equal(((await unknown.json()) as { error: string }).error, "recipient_not_found");

    const ambiguous = await handler(
      post(J5_MACHINE_API_PATHS.send, { to: "twin", message: "x", clientRequestId: "r2" }),
    );
    assert.equal(ambiguous.status, 409);
    const ambiguousBody = (await ambiguous.json()) as {
      error: string;
      candidates: ReadonlyArray<{ participantId: string }>;
    };
    assert.equal(ambiguousBody.error, "recipient_ambiguous");
    assert.equal(ambiguousBody.candidates.length, 2);

    const toMachine = await handler(
      post(J5_MACHINE_API_PATHS.send, { to: "machine:other", message: "x", clientRequestId: "r3" }),
    );
    assert.equal(toMachine.status, 403);
    const policyBody = (await toMachine.json()) as { error: string; reason: string };
    assert.equal(policyBody.error, "policy_refused");
    assert.equal(policyBody.reason, "A2AMachineCannotReceiveError");

    const malformed = await handler(post(J5_MACHINE_API_PATHS.send, { to: "obs-sentinel" }));
    assert.equal(malformed.status, 400);
  } finally {
    await dispose();
  }
});

it("answers whoami and the roster for a machine token, and the roster for a read-only client", async () => {
  const machine = makeHandler({ subject: watchdog.participantId, scopes: [AuthA2ASendScope] });
  const reader = makeHandler({ subject: "browser", scopes: [AuthOrchestrationReadScope] });
  const stranger = makeHandler({ subject: "browser", scopes: [] });
  const peer = makeHandler({ subject: "peer:environment-home", scopes: [AuthA2APeerScope] });
  try {
    const whoami = await machine.handler(get(J5_MACHINE_API_PATHS.whoami));
    assert.equal(whoami.status, 200);
    const identity = (await whoami.json()) as {
      participant: { participantId: string; squadronName: string };
      server: { version: string };
    };
    assert.equal(identity.participant.participantId, watchdog.participantId);
    assert.equal(identity.participant.squadronName, "Monitoring");
    assert.isString(identity.server.version);

    assert.equal((await machine.handler(get(J5_MACHINE_API_PATHS.roster))).status, 200);
    assert.equal((await reader.handler(get(J5_MACHINE_API_PATHS.roster))).status, 200);
    assert.equal((await stranger.handler(get(J5_MACHINE_API_PATHS.roster))).status, 403);
    assert.equal(
      (await peer.handler(get(J5_MACHINE_API_PATHS.roster))).status,
      403,
      "a peer credential reads the peer roster route, never the shared roster",
    );
    assert.equal((await reader.handler(get(J5_MACHINE_API_PATHS.whoami))).status, 403);
  } finally {
    await peer.dispose();
    await machine.dispose();
    await reader.dispose();
    await stranger.dispose();
  }
});

it("registers a machine only for an operate-scoped client", async () => {
  const operator = makeHandler({ subject: "cli", scopes: [AuthOrchestrationOperateScope] });
  const machine = makeHandler({ subject: watchdog.participantId, scopes: [AuthA2ASendScope] });
  try {
    const created = await operator.handler(
      post(J5_MACHINE_API_PATHS.machineParticipants, {
        squadronId: "squadron:monitoring",
        name: "watchd",
      }),
    );
    assert.equal(created.status, 201);
    const body = (await created.json()) as { participant: { name: string }; created: boolean };
    assert.equal(body.participant.name, "watchd");
    assert.isTrue(body.created);

    const badName = await operator.handler(
      post(J5_MACHINE_API_PATHS.machineParticipants, {
        squadronId: "squadron:monitoring",
        name: "Not Valid",
      }),
    );
    assert.equal(badName.status, 400);

    const refused = await machine.handler(
      post(J5_MACHINE_API_PATHS.machineParticipants, {
        squadronId: "squadron:monitoring",
        name: "another",
      }),
    );
    assert.equal(refused.status, 403);
  } finally {
    await operator.dispose();
    await machine.dispose();
  }
});
