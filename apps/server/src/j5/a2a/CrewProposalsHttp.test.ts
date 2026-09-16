import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { AgentCrewProposalService, type CrewProposal } from "./AgentCrewProposalService.ts";
import { makeCrewProposalsHttpRouteLayer } from "./CrewProposalsHttp.ts";
import { CrewProposalNotOpenError, CrewProposalService } from "./CrewProposalService.ts";
import { ParticipantId, SquadronId } from "./contracts.ts";

const proposal: CrewProposal = {
  id: "crew:j5:a2a:mcp:j5-crew-proposal:proposal:req",
  squadronId: SquadronId.make("squadron:gate"),
  captainParticipantId: ParticipantId.make("agent:j5:a2a:thread:captain"),
  captainThreadId: ThreadId.make("thread:captain"),
  crewInstanceId: null,
  kind: "roster",
  status: "open",
  brief: "Fix the flaky login test.",
  displayName: "Login Fix Crew",
  requestedSeats: [{ seat: "builder", agentId: "builder", reason: "Implements the fix" }],
  approvedSeats: null,
  createdAt: "2026-09-09T16:00:00.000Z",
  resolvedAt: null,
};

const paths = { list: "/raw/crews/proposals", resolve: "/raw/crews/proposals/resolve" } as const;

const authWith = (scopes: ReadonlyArray<string>) =>
  Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: () =>
      Effect.succeed({
        sessionId: AuthSessionId.make("auth-session:crew-gate"),
        subject: "crew-gate-test",
        method: "bearer-access-token",
        scopes: scopes as never,
      }),
  });

it("lists open proposals for readers and resolves them only for operators", async () => {
  const resolved: Array<{ proposalId: string; decision: string; seats?: unknown }> = [];
  const gate = Layer.mock(CrewProposalService)({
    resolve: (input) => {
      resolved.push(input);
      return input.proposalId === proposal.id
        ? Effect.succeed({
            proposal: {
              ...proposal,
              status: "approved" as const,
              approvedSeats: input.seats ?? proposal.requestedSeats,
            },
            instance: null,
          })
        : Effect.fail(
            new CrewProposalNotOpenError({ proposalId: input.proposalId, status: "declined" }),
          );
    },
  });
  const store = Layer.mock(AgentCrewProposalService)({
    listOpen: () => Effect.succeed([proposal]),
  });
  const routes = (scopes: ReadonlyArray<string>) =>
    makeCrewProposalsHttpRouteLayer(paths).pipe(
      Layer.provide(Layer.mergeAll(gate, store)),
      Layer.provideMerge(authWith(scopes)),
      Layer.provide(HttpServer.layerServices),
    );
  const operator = HttpRouter.toWebHandler(
    routes([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]),
    {
      disableLogger: true,
    },
  );
  const reader = HttpRouter.toWebHandler(routes([AuthOrchestrationReadScope]), {
    disableLogger: true,
  });
  try {
    const list = await operator.handler(
      new Request(`http://environment.test${paths.list}`, { method: "POST", body: "{}" }),
    );
    assert.equal(list.status, 200);
    const body = (await list.json()) as {
      proposals: Array<{ id: string; requestedSeats: unknown[] }>;
    };
    assert.equal(body.proposals[0]?.id, proposal.id);
    assert.lengthOf(body.proposals[0]?.requestedSeats ?? [], 1);

    const approved = await operator.handler(
      new Request(`http://environment.test${paths.resolve}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          proposalId: proposal.id,
          decision: "approve",
          seats: [
            ...proposal.requestedSeats,
            { seat: "critic", agentId: "critic", reason: "Human added review" },
          ],
        }),
      }),
    );
    assert.equal(approved.status, 200);
    const approvedBody = (await approved.json()) as {
      proposal: { status: string; approvedSeats: unknown[] };
    };
    assert.equal(approvedBody.proposal.status, "approved");
    assert.lengthOf(approvedBody.proposal.approvedSeats, 2);

    const stale = await operator.handler(
      new Request(`http://environment.test${paths.resolve}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposalId: "other", decision: "decline" }),
      }),
    );
    assert.equal(stale.status, 409);

    const invalid = await operator.handler(
      new Request(`http://environment.test${paths.resolve}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposalId: proposal.id, decision: "maybe" }),
      }),
    );
    assert.equal(invalid.status, 400);

    const forbidden = await reader.handler(
      new Request(`http://environment.test${paths.resolve}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposalId: proposal.id, decision: "decline" }),
      }),
    );
    assert.equal(forbidden.status, 403);
    assert.lengthOf(resolved, 2);
  } finally {
    await operator.dispose();
    await reader.dispose();
  }
});
