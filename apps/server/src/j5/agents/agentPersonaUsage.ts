import { type AgentPersonaUsage, AgentPersonaUsageEntry } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Aggregate saved-agent usage from the orchestration projections. Threads carry the pinned
 * `agentPersonaAssignment` in their payload, so grouping by its persona id needs no new
 * columns or tables. Deleted threads are excluded; archived ones still count as history.
 */
const PERSONA = `json_extract(t.payload_json, '$.agentPersonaAssignment.personaId')`;

type RouteRow = {
  readonly persona_id: string;
  readonly driver: string;
  readonly model: string;
  readonly threads: number;
  readonly last_launched_at: string;
};
type RunRow = {
  readonly persona_id: string;
  readonly status: string;
  readonly runs: number;
  readonly completed_ms: number | null;
  readonly completed_count: number;
};
type TokenRow = {
  readonly persona_id: string;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly reported: number;
};

const decodeEntry = Schema.decodeUnknownSync(AgentPersonaUsageEntry);

export const agentPersonaUsage = Effect.fn("j5.agentPersonaUsage")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const routes = yield* sql<RouteRow>`
    SELECT ${sql.literal(PERSONA)} AS persona_id,
      json_extract(t.payload_json, '$.agentPersonaAssignment.resolvedDriver') AS driver,
      json_extract(t.payload_json, '$.agentPersonaAssignment.resolvedModelSelection.model') AS model,
      COUNT(*) AS threads,
      MAX(t.created_at) AS last_launched_at
    FROM orchestration_v2_projection_threads AS t
    WHERE t.deleted_at IS NULL AND ${sql.literal(PERSONA)} IS NOT NULL
    GROUP BY 1, 2, 3
  `;
  const runs = yield* sql<RunRow>`
    SELECT ${sql.literal(PERSONA)} AS persona_id,
      r.status AS status,
      COUNT(*) AS runs,
      SUM(CASE WHEN r.completed_at IS NOT NULL
        THEN (julianday(r.completed_at) - julianday(r.requested_at)) * 86400000 END) AS completed_ms,
      SUM(CASE WHEN r.completed_at IS NOT NULL THEN 1 ELSE 0 END) AS completed_count
    FROM orchestration_v2_projection_runs AS r
    INNER JOIN orchestration_v2_projection_threads AS t ON t.thread_id = r.thread_id
    WHERE t.deleted_at IS NULL AND ${sql.literal(PERSONA)} IS NOT NULL
    GROUP BY 1, 2
  `;
  const tokens = yield* sql<TokenRow>`
    SELECT ${sql.literal(PERSONA)} AS persona_id,
      SUM(json_extract(p.payload_json, '$.turnTokenUsage.inputTokens')) AS input_tokens,
      SUM(json_extract(p.payload_json, '$.turnTokenUsage.outputTokens')) AS output_tokens,
      COUNT(json_extract(p.payload_json, '$.turnTokenUsage')) AS reported
    FROM orchestration_v2_projection_provider_turns AS p
    INNER JOIN orchestration_v2_projection_threads AS t ON t.thread_id = p.thread_id
    WHERE t.deleted_at IS NULL AND ${sql.literal(PERSONA)} IS NOT NULL
    GROUP BY 1
  `;

  const entries = new Map<
    string,
    {
      threads: number;
      runs: number;
      completedRuns: number;
      failedRuns: number;
      completedMs: number;
      completedCount: number;
      lastLaunchedAt: string | null;
      inputTokens: number | null;
      outputTokens: number | null;
      routes: Array<{ driver: string; model: string; threads: number }>;
    }
  >();
  const entry = (personaId: string) => {
    const existing = entries.get(personaId);
    if (existing) return existing;
    const created = {
      threads: 0,
      runs: 0,
      completedRuns: 0,
      failedRuns: 0,
      completedMs: 0,
      completedCount: 0,
      lastLaunchedAt: null,
      inputTokens: null,
      outputTokens: null,
      routes: [],
    };
    entries.set(personaId, created);
    return created;
  };
  for (const row of routes) {
    const current = entry(row.persona_id);
    current.threads += Number(row.threads);
    current.routes.push({ driver: row.driver, model: row.model, threads: Number(row.threads) });
    if (current.lastLaunchedAt === null || row.last_launched_at > current.lastLaunchedAt)
      current.lastLaunchedAt = row.last_launched_at;
  }
  for (const row of runs) {
    const current = entry(row.persona_id);
    current.runs += Number(row.runs);
    if (row.status === "completed") {
      current.completedRuns += Number(row.runs);
      current.completedMs += Number(row.completed_ms ?? 0);
      current.completedCount += Number(row.completed_count);
    } else if (row.status === "failed") current.failedRuns += Number(row.runs);
  }
  for (const row of tokens) {
    if (Number(row.reported) === 0) continue;
    const current = entry(row.persona_id);
    current.inputTokens = Math.round(Number(row.input_tokens ?? 0));
    current.outputTokens = Math.round(Number(row.output_tokens ?? 0));
  }
  const personas: AgentPersonaUsage["personas"] = [...entries.entries()]
    .map(([personaId, current]) =>
      decodeEntry({
        personaId,
        threads: current.threads,
        runs: current.runs,
        completedRuns: current.completedRuns,
        failedRuns: current.failedRuns,
        averageRunDurationMs:
          current.completedCount === 0
            ? null
            : Math.max(0, Math.round(current.completedMs / current.completedCount)),
        lastLaunchedAt: current.lastLaunchedAt,
        inputTokens: current.inputTokens,
        outputTokens: current.outputTokens,
        routes: current.routes.toSorted((a, b) => b.threads - a.threads),
      }),
    )
    .toSorted((a, b) => b.threads - a.threads || a.personaId.localeCompare(b.personaId));
  return { personas };
});
