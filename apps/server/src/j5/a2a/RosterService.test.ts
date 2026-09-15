import { assert, it } from "@effect/vitest";
import { type OrchestrationV2ShellSnapshot, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { RosterService, layer as rosterLayer, livenessForShellThread } from "./RosterService.ts";
import {
  type AgentParticipant,
  CommCommandId,
  type MachineParticipant,
  ParticipantId,
  SquadronId,
} from "./contracts.ts";

const timestamp = "2026-09-15T12:00:00.000Z";
const squadronId = SquadronId.make("squadron:monitoring");

const sentinel: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:j5:a2a:thread:sentinel"),
  threadId: ThreadId.make("thread:sentinel"),
};
const twinOne: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:j5:a2a:thread:twin-one"),
  threadId: ThreadId.make("thread:twin-one"),
};
const twinTwo: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:j5:a2a:thread:twin-two"),
  threadId: ThreadId.make("thread:twin-two"),
};
const watchdog: MachineParticipant = {
  kind: "machine",
  id: ParticipantId.make("machine:watchdog"),
  name: "watchdog",
};

/** Only the fields the roster reads; the rest of the shell is irrelevant here. */
const shell = (input: {
  readonly id: ThreadId;
  readonly title: string;
  readonly status: string;
  readonly activeRunId?: string | null;
  readonly lastError?: string | null;
}) =>
  ({
    id: input.id,
    title: input.title,
    status: input.status,
    activeRunId: input.activeRunId ?? null,
    latestRunStartedAt: DateTime.makeUnsafe("2026-09-15T11:59:00.000Z"),
    latestRunCompletedAt: input.activeRunId ? null : DateTime.makeUnsafe(timestamp),
    lastError: input.lastError ?? null,
  }) as unknown as OrchestrationV2ShellSnapshot["threads"][number];

const snapshot = {
  threads: [
    shell({
      id: sentinel.threadId,
      title: "obs-sentinel",
      status: "running",
      activeRunId: "run:1",
    }),
    shell({ id: twinOne.threadId, title: "Twin", status: "completed" }),
    shell({ id: twinTwo.threadId, title: "twin", status: "failed", lastError: "boom" }),
  ],
  archivedThreads: [],
} as unknown as OrchestrationV2ShellSnapshot;

const makeTestLayer = () => {
  const database = NodeSqliteClient.layerMemory();
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const orchestrator = Layer.mock(OrchestratorV2)({
    getShellSnapshot: () => Effect.succeed(snapshot),
  });
  const roster = rosterLayer.pipe(Layer.provide(database), Layer.provide(orchestrator));
  return Layer.mergeAll(database, ledger, roster);
};

const setup = Effect.fn("test.j5.a2a.roster.setup")(function* () {
  yield* runJ5A2AMigrations();
  const ledger = yield* A2ALedger;
  const sql = yield* SqlClient.SqlClient;
  yield* ledger.createSquadron({
    squadron: { id: squadronId, name: "Monitoring", createdAt: timestamp },
  });
  for (const [index, participant] of [sentinel, twinOne, twinTwo, watchdog].entries()) {
    yield* ledger.append({
      commandId: CommCommandId.make(`command:join:${String(index)}`),
      squadronId,
      acceptedAt: timestamp,
      event: {
        kind: "participant.joined",
        sender: null,
        receiver: participant.id,
        exchangeId: null,
        correlationId: null,
        payload: { participant },
        createdAt: timestamp,
      },
    });
  }
  yield* sql`
    INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at)
    VALUES ('human:operator', 1, ${timestamp})
  `;
});

it("derives liveness from the measured shell status", () => {
  assert.equal(
    livenessForShellThread(
      shell({ id: sentinel.threadId, title: "s", status: "running", activeRunId: "run:1" }),
    ).state,
    "active",
  );
  assert.equal(
    livenessForShellThread(shell({ id: sentinel.threadId, title: "s", status: "queued" })).state,
    "active",
  );
  assert.equal(
    livenessForShellThread(shell({ id: sentinel.threadId, title: "s", status: "failed" })).state,
    "errored",
  );
  const idle = livenessForShellThread(
    shell({ id: sentinel.threadId, title: "s", status: "completed" }),
  );
  assert.equal(idle.state, "idle");
  assert.equal(idle.runStatus, "completed");
  assert.equal(idle.latestRunCompletedAt, timestamp);
});

it.effect(
  "lists agents with liveness, people, and machines, and resolves recipients by id, thread, or name",
  () =>
    Effect.gen(function* () {
      yield* setup();
      const roster = yield* RosterService;

      const entries = yield* roster.list();
      const byId = new Map(entries.map((entry) => [entry.participantId, entry] as const));
      const sentinelRow = byId.get(sentinel.id)!;
      assert.equal(sentinelRow.kind, "agent");
      assert.equal(sentinelRow.displayName, "obs-sentinel");
      assert.equal(sentinelRow.squadronName, "Monitoring");
      assert.isTrue(sentinelRow.canReceiveMessage);
      assert.equal(sentinelRow.liveness?.state, "active");
      assert.equal(byId.get(twinTwo.id)?.liveness?.state, "errored");
      assert.equal(byId.get(twinTwo.id)?.liveness?.lastError, "boom");

      const machineRow = byId.get(watchdog.id)!;
      assert.equal(machineRow.kind, "machine");
      assert.equal(machineRow.displayName, "watchdog");
      assert.isFalse(machineRow.canReceiveMessage);
      assert.isNull(machineRow.liveness);

      const personRow = byId.get(ParticipantId.make("human:operator"))!;
      assert.equal(personRow.kind, "human");
      assert.isTrue(personRow.acceptsUrgency);

      assert.deepStrictEqual(yield* roster.resolveRecipient("OBS-Sentinel"), {
        kind: "resolved",
        participantId: sentinel.id,
      });
      assert.deepStrictEqual(yield* roster.resolveRecipient("thread:sentinel"), {
        kind: "resolved",
        participantId: sentinel.id,
      });
      assert.deepStrictEqual(yield* roster.resolveRecipient(watchdog.id), {
        kind: "resolved",
        participantId: watchdog.id,
      });
      const ambiguous = yield* roster.resolveRecipient("twin");
      assert.equal(ambiguous.kind, "ambiguous");
      if (ambiguous.kind === "ambiguous") {
        assert.deepStrictEqual(
          ambiguous.candidates.map((candidate) => candidate.participantId).toSorted(),
          [twinOne.id, twinTwo.id].toSorted(),
        );
      }
      assert.deepStrictEqual(yield* roster.resolveRecipient("nobody"), { kind: "not_found" });
    }).pipe(Effect.provide(makeTestLayer())),
);
