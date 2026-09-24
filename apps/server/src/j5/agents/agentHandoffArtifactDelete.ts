import type { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { AgentHandoffRefreshes, bumpAgentHandoffRefreshes } from "./agentHandoffRefreshes.ts";

interface AgentHandoffArtifactDeleteShape {
  readonly reconcile: (input: {
    readonly projectId: ProjectId;
    readonly path: string;
  }) => Effect.Effect<void, SqlError>;
}

/** Keeps persisted handoff state honest when its backing artifact is deleted. */
export class AgentHandoffArtifactDelete extends Context.Service<
  AgentHandoffArtifactDelete,
  AgentHandoffArtifactDeleteShape
>()("t3/j5/agents/agentHandoffArtifactDelete") {}

export const layer: Layer.Layer<
  AgentHandoffArtifactDelete,
  never,
  AgentHandoffRefreshes | SqlClient.SqlClient
> = Layer.effect(
  AgentHandoffArtifactDelete,
  Effect.gen(function* () {
    const refreshes = yield* AgentHandoffRefreshes;
    const sql = yield* SqlClient.SqlClient;
    const reconcile: AgentHandoffArtifactDeleteShape["reconcile"] = Effect.fn(
      "j5.agentHandoffArtifactDelete.reconcile",
    )(function* (input) {
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      const changed = yield* sql`
        UPDATE j5_agent_handoffs SET status = 'missing', checked_at = ${checkedAt}
        WHERE project_id = ${input.projectId} AND path = ${input.path} AND status != 'missing'
        RETURNING thread_id
      `;
      if (changed.length === 0) return;
      yield* bumpAgentHandoffRefreshes(refreshes);
    });
    return AgentHandoffArtifactDelete.of({ reconcile });
  }),
);
