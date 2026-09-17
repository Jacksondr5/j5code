import type { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { AgentHandoffRefreshes, bumpAgentHandoffRefreshes } from "./agentHandoffRefreshes.ts";
import { makeAgentHandoffStore } from "./agentHandoffStore.ts";

interface AgentHandoffArtifactTrashShape {
  readonly reconcile: (input: {
    readonly projectId: ProjectId;
    readonly path: string;
  }) => Effect.Effect<void, SqlError>;
}

/** Keeps persisted handoff state honest when its backing artifact is moved to Trash. */
export class AgentHandoffArtifactTrash extends Context.Service<
  AgentHandoffArtifactTrash,
  AgentHandoffArtifactTrashShape
>()("t3/j5/agents/agentHandoffArtifactTrash") {}

export const layer: Layer.Layer<
  AgentHandoffArtifactTrash,
  never,
  AgentHandoffRefreshes | SqlClient.SqlClient
> = Layer.effect(
  AgentHandoffArtifactTrash,
  Effect.gen(function* () {
    const refreshes = yield* AgentHandoffRefreshes;
    const store = yield* makeAgentHandoffStore;
    const reconcile: AgentHandoffArtifactTrashShape["reconcile"] = Effect.fn(
      "j5.agentHandoffArtifactTrash.reconcile",
    )(function* (input) {
      const matches = (yield* store.listByProjectPath(input.projectId, input.path)).filter(
        (handoff) => handoff.status !== "missing",
      );
      if (matches.length === 0) return;

      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      yield* Effect.forEach(
        matches,
        (handoff) => store.upsert({ ...handoff, status: "missing", checkedAt }),
        { discard: true },
      );
      yield* bumpAgentHandoffRefreshes(refreshes);
    });
    return AgentHandoffArtifactTrash.of({ reconcile });
  }),
);
