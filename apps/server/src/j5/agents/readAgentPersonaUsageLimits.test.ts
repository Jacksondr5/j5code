import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { layerMemory } from "../../persistence/Sqlite.ts";
import { readAgentPersonaLimitedInstances } from "./readAgentPersonaUsageLimits.ts";
import { resolveAgentPersonaRoute } from "./agentPersonaRouting.ts";
import { BUILT_IN_AGENT_PERSONAS } from "./agentPersonas.ts";

it.effect(
  "skips persisted worker limits without telemetry and clears expired or superseded signals",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const before = "2026-11-03T10:00:00.000Z";
      const now = Date.parse("2026-11-03T12:00:00.000Z");
      const seed = Effect.fn("fixture.seedWorker")(function* (
        id: string,
        resetAt: string | null,
        archived = false,
      ) {
        const payload = JSON.stringify({ archivedAt: archived ? before : null });
        yield* sql`INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode, interaction_mode, created_at, updated_at, deleted_at, payload_json)
        VALUES (${id}, 'project', 'Worker', 'codex', ${id}, 'full-access', 'default', ${before}, ${before}, NULL, ${payload})`;
        const runId = `${id}-run`;
        const run = JSON.stringify({ rootNodeId: null, startedAt: before, providerInstanceId: id });
        yield* sql`INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, completed_at, payload_json)
        VALUES (${runId}, ${id}, 1, 'codex', ${id}, 'failed', ${before}, ${before}, ${run})`;
        const error = JSON.stringify({ failure: { class: "usage_limit", resetAt } });
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, node_id, ordinal, type, status, updated_at, payload_json)
        VALUES (${id}, ${id}, ${runId}, NULL, 1, 'error', 'failed', ${before}, ${error})`;
      });
      yield* seed("managed", null);
      yield* seed("proxy", "2026-11-03T13:00:00.000Z");
      yield* seed("elapsed", "2026-11-03T11:00:00.000Z");
      yield* seed("archived", null, true);
      yield* seed("changed-account", null);
      yield* sql`UPDATE orchestration_v2_projection_threads SET provider_instance_id = 'replacement' WHERE thread_id = 'changed-account'`;
      const limited = yield* readAgentPersonaLimitedInstances(now);
      assert.deepStrictEqual([...limited].sort(), ["managed", "proxy"]);
      const providers = ["managed", "ready"].map((id) => ({
        instanceId: ProviderInstanceId.make(id),
        driver: BUILT_IN_AGENT_PERSONAS.scout.modelRoute[0].driver,
        enabled: true,
        installed: true,
        version: null,
        status: "ready" as const,
        auth: { status: "authenticated" as const },
        checkedAt: before,
        models: [{ slug: "model", name: "Model", isCustom: false, capabilities: {} }],
        slashCommands: [],
        skills: [],
      }));
      const resolution = resolveAgentPersonaRoute({
        now,
        personaId: "scout",
        limitedInstances: limited,
        definition: {
          ...BUILT_IN_AGENT_PERSONAS.scout,
          modelRoute: [
            { instanceId: providers[0]!.instanceId, model: "model" },
            ...providers.slice(1).map(({ instanceId }) => ({ instanceId, model: "model" })),
          ],
        },
        providers,
      });
      assert.equal(resolution.status, "available");
      if (resolution.status === "available") {
        assert.equal(String(resolution.modelSelection.instanceId), "ready");
        assert.deepStrictEqual(resolution.rejectedTargets[0]?.failures, [
          { code: "usage-limit", instanceId: ProviderInstanceId.make("managed") },
        ]);
      }
      yield* seed("overlap", null);
      yield* sql`UPDATE orchestration_v2_projection_threads SET provider_instance_id = 'managed' WHERE thread_id = 'overlap'`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, completed_at, payload_json)
      VALUES ('overlap-success', 'overlap', 2, 'codex', 'managed', 'completed', '2026-11-03T09:00:00.000Z', '2026-11-03T11:30:00.000Z', '{}')`;
      assert.isTrue(
        (yield* readAgentPersonaLimitedInstances(now)).has(ProviderInstanceId.make("managed")),
      );
      yield* seed("recovered", null);
      yield* seed("other-worker", null);
      yield* sql`UPDATE orchestration_v2_projection_threads SET provider_instance_id = 'recovered' WHERE thread_id = 'other-worker'`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, completed_at, payload_json)
      VALUES ('other-success', 'other-worker', 2, 'codex', 'recovered', 'completed', '2026-11-03T11:00:00.000Z', '2026-11-03T11:30:00.000Z', '{}')`;
      assert.isFalse(
        (yield* readAgentPersonaLimitedInstances(now)).has(ProviderInstanceId.make("recovered")),
      );
      // A queued delivery does not erase the failed worker's observed limit.
      yield* sql`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, completed_at, payload_json)
      VALUES ('queued', 'managed', 2, 'codex', 'managed', 'queued', ${before}, NULL, '{}')`;
      assert.isTrue(
        (yield* readAgentPersonaLimitedInstances(now)).has(ProviderInstanceId.make("managed")),
      );
      yield* sql`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, completed_at, payload_json)
      VALUES ('success', 'managed', 3, 'codex', 'managed', 'completed', '2026-11-03T11:00:00.000Z', '2026-11-03T11:30:00.000Z', '{}')`;
      assert.deepStrictEqual([...(yield* readAgentPersonaLimitedInstances(now))], ["proxy"]);
      assert.deepStrictEqual(
        [...(yield* readAgentPersonaLimitedInstances(Date.parse("2026-11-03T14:00:00.000Z")))],
        [],
      );
    }).pipe(Effect.provide(layerMemory)),
);
