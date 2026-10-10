import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { AnalyticsService } from "../../telemetry/AnalyticsService.ts";
import {
  AgentCrewInstanceService,
  layer as crewInstanceLayer,
} from "../a2a/AgentCrewInstanceService.ts";
import { CommCommandId, ExchangeId, LedgerProjectId, ParticipantId } from "../a2a/contracts.ts";
import { participantIdForThread } from "../a2a/HomeRegistrar.ts";
import { A2ALedger, layer as ledgerLayer } from "../a2a/LedgerService.ts";
import { runJ5A2AMigrations } from "../a2a/Migrations.ts";
import { FleetSnapshot, manualLayer } from "./FleetSnapshot.ts";

const at = "2026-10-10T12:00:00.000Z";
const projectId = LedgerProjectId.make("ledger:fleet-snapshot");
const threadIdOf = (name: string) => ThreadId.make(`thread:fleet-snapshot:${name}`);

/** A thread row as the projection stores it, with the runs it holds. */
const thread = Effect.fn(function* (
  name: string,
  createdBy: "user" | "agent",
  runs: ReadonlyArray<string>,
  archived = false,
) {
  const sql = yield* SqlClient.SqlClient;
  const threadId = threadIdOf(name);
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, archived_at, payload_json
    ) VALUES (
      ${threadId}, 'project:fleet-snapshot', ${name}, 'codex', 'full-access', 'default',
      ${at}, ${at}, ${archived ? at : null}, ${JSON.stringify({ createdBy })}
    )
  `;
  for (const [index, status] of runs.entries())
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, status, requested_at, payload_json
      ) VALUES (
        ${`run:${name}:${index}`}, ${threadId}, ${index + 1}, 'codex', ${status}, ${at}, '{}'
      )
    `;
  return threadId;
});

it.effect("counts what the fleet is doing right now, and names nothing", () =>
  Effect.gen(function* () {
    const recorded: Array<Readonly<Record<string, unknown>>> = [];
    yield* Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      const snapshot = yield* FleetSnapshot;

      yield* snapshot.record;

      // The person's thread is mid-turn with a follow-up queued behind it.
      const captain = yield* thread("captain", "user", ["completed", "running", "queued"]);
      // Two seats: one working, one waiting on an approval.
      const builder = yield* thread("builder", "agent", ["running"]);
      const critic = yield* thread("critic", "agent", ["waiting"]);
      // An idle spawned agent, and a retired one whose last run is long over.
      yield* thread("idle", "agent", ["completed"]);
      yield* thread("retired", "agent", ["completed"], true);

      const ledger = yield* A2ALedger;
      yield* ledger.ensureProject({ projectId, createdAt: at });
      yield* (yield* AgentCrewInstanceService).record({
        id: "crew:fleet-snapshot",
        projectId,
        captainParticipantId: participantIdForThread(captain),
        captainThreadId: captain,
        displayName: "Crew",
        brief: "Brief.",
        createdAt: at,
        members: [builder, critic].map((threadId, index) => ({
          seatName: `seat-${index}`,
          agentId: "builder",
          participantId: participantIdForThread(threadId),
          threadId,
          reason: null,
        })),
      });
      for (const [name, receiver] of [
        ["to-person", ParticipantId.make("human:global")],
        ["to-agent", participantIdForThread(critic)],
      ] as const)
        yield* ledger.append({
          commandId: CommCommandId.make(`command:fleet-snapshot:${name}`),
          projectId,
          acceptedAt: at,
          event: {
            kind: "exchange.opened",
            sender: participantIdForThread(builder),
            receiver,
            exchangeId: ExchangeId.make(`exchange:fleet-snapshot:${name}`),
            correlationId: null,
            payload: { intent: "The intent never leaves the machine", urgency: null },
            createdAt: at,
          },
        });

      yield* snapshot.record;
    }).pipe(
      Effect.provide(
        manualLayer.pipe(
          Layer.provideMerge(Layer.mergeAll(ledgerLayer, crewInstanceLayer)),
          Layer.provide(
            Layer.succeed(
              AnalyticsService,
              AnalyticsService.of({
                record: (event, properties = {}) =>
                  Effect.sync(() => void recorded.push({ event, ...properties })),
                flush: Effect.void,
              }),
            ),
          ),
          Layer.provideMerge(SqlitePersistence.layerMemory),
        ),
      ),
    );

    const empty = {
      event: "j5.fleet.snapshot",
      openThreads: 0,
      workingThreads: 0,
      workingAgentStartedThreads: 0,
      queuedRuns: 0,
      liveCrews: 0,
      largestCrewSeats: 0,
      openAsksToPerson: 0,
      openAsksToAgents: 0,
    };
    assert.deepStrictEqual(recorded, [
      empty,
      {
        ...empty,
        openThreads: 4,
        workingThreads: 3,
        workingAgentStartedThreads: 2,
        queuedRuns: 1,
        liveCrews: 1,
        largestCrewSeats: 2,
        openAsksToPerson: 1,
        openAsksToAgents: 1,
      },
    ]);
  }),
);
