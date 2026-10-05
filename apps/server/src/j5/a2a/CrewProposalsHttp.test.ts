import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { PlaybookStore, playbookStoreLayer } from "../playbooks/PlaybookStore.ts";
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
  reportedAt: null,
};

const customSeat = {
  seat: "critic",
  agentId: null,
  reason: "Human added review",
  instructions: "Review the proposed fix.",
  modelSelection: {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-fable-5-1",
    options: [{ id: "effort", value: "high" }],
  },
  runtimeMode: "approval-required" as const,
};

const paths = {
  list: "/raw/crews/proposals",
  resolve: "/raw/crews/proposals/resolve",
  preview: "/raw/crews/proposals/preview",
} as const;

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
  const resolved: Array<{
    proposalId: string;
    decision: string;
    seats?: unknown;
    approvalToken?: string | undefined;
  }> = [];
  const previewed: unknown[] = [];
  const gate = Layer.mock(CrewProposalService)({
    preview: (input) => {
      previewed.push(input);
      return Effect.succeed({
        proposalId: input.proposalId,
        approvalToken: "runtime-token",
        seats: [
          {
            seat: "critic",
            provider: "Anthropic",
            harness: "Claude Code",
            model: "Claude Fable 5.1",
            reasoning: "High",
            access: "Supervised",
            modelSelection: customSeat.modelSelection,
            runtimeMode: customSeat.runtimeMode,
          },
        ],
      });
    },
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
      Layer.provide(Layer.mergeAll(gate, store, Layer.mock(PlaybookStore)({}))),
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

    const preview = await reader.handler(
      new Request(`http://environment.test${paths.preview}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposalId: proposal.id, seats: [customSeat] }),
      }),
    );
    assert.equal(preview.status, 200);
    assert.deepStrictEqual(previewed, [{ proposalId: proposal.id, seats: [customSeat] }]);
    assert.deepStrictEqual(await preview.json(), {
      proposalId: proposal.id,
      approvalToken: "runtime-token",
      seats: [
        {
          seat: "critic",
          provider: "Anthropic",
          harness: "Claude Code",
          model: "Claude Fable 5.1",
          reasoning: "High",
          access: "Supervised",
          modelSelection: customSeat.modelSelection,
          runtimeMode: customSeat.runtimeMode,
        },
      ],
    });

    const approved = await operator.handler(
      new Request(`http://environment.test${paths.resolve}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          proposalId: proposal.id,
          decision: "approve",
          approvalToken: "runtime-token",
          seats: [...proposal.requestedSeats, customSeat],
        }),
      }),
    );
    assert.equal(approved.status, 200);
    assert.equal(resolved[0]?.approvalToken, "runtime-token");
    assert.deepStrictEqual(resolved[0]?.seats, [...proposal.requestedSeats, customSeat]);
    const approvedBody = (await approved.json()) as {
      proposal: { status: string; approvedSeats: unknown[] };
    };
    assert.equal(approvedBody.proposal.status, "approved");
    assert.deepStrictEqual(approvedBody.proposal.approvedSeats, [
      ...proposal.requestedSeats,
      customSeat,
    ]);

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

it.effect(
  "projects each open proposal's playbook from the live YAML, and a broken one as its issue",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "j5-crew-proposals-http-" });
      yield* fs.makeDirectory(path.join(root, ".j5/playbooks"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, ".j5/playbooks/release.yaml"),
        "title: Release\ndescription: Ship.\nsteps:\n  - id: plan\n    title: Plan\n    prompt: Plan.\n    persona: planner\n  - id: review\n    title: Review\n    prompt: Review.\n",
      );
      const withPlaybook = (
        id: string,
        name: string,
        steps: ReadonlyArray<string>,
      ): CrewProposal => ({
        ...proposal,
        id,
        requestedSeats: [{ seat: "planner", agentId: null, reason: "Plans", steps }],
        playbook: { name, definitionPath: path.join(root, ".j5/playbooks", `${name}.yaml`) },
      });
      const store = Layer.mock(AgentCrewProposalService)({
        listOpen: () =>
          Effect.succeed([
            proposal,
            withPlaybook("p-live", "release", ["plan"]),
            withPlaybook("p-lost", "release", ["ship"]),
            withPlaybook("p-gone", "gone", []),
          ]),
      });
      const routes = makeCrewProposalsHttpRouteLayer(paths).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(CrewProposalService)({}),
            store,
            playbookStoreLayer.pipe(
              Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
              Layer.provide(NodeServices.layer),
            ),
          ),
        ),
        Layer.provideMerge(authWith([AuthOrchestrationReadScope])),
        Layer.provide(HttpServer.layerServices),
      );
      const reader = HttpRouter.toWebHandler(routes, { disableLogger: true });
      yield* Effect.addFinalizer(() => Effect.promise(() => reader.dispose()));
      const list = yield* Effect.promise(() =>
        reader.handler(
          new Request(`http://environment.test${paths.list}`, { method: "POST", body: "{}" }),
        ),
      );
      assert.equal(list.status, 200);
      const { proposals } = (yield* Effect.promise(() => list.json())) as {
        proposals: Array<{
          id: string;
          playbook?: { name: string; title: string; steps: unknown[]; issue: string | null } | null;
        }>;
      };
      assert.isNull(proposals[0]?.playbook);
      assert.deepStrictEqual(proposals[1]?.playbook, {
        name: "release",
        title: "Release",
        steps: [
          { id: "plan", title: "Plan", persona: "planner" },
          { id: "review", title: "Review" },
        ],
        issue: null,
      });
      assert.include(proposals[2]?.playbook?.issue, "Step ship is no longer in the playbook");
      assert.deepStrictEqual(proposals[3]?.playbook?.steps, []);
      assert.include(proposals[3]?.playbook?.issue, "No playbook named gone");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
