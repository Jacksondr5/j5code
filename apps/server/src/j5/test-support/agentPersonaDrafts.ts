import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AgentCrewInstanceService } from "../a2a/AgentCrewInstanceService.ts";
import createDraftTable from "../a2a/migrations/054_PersonaDrafts.ts";
import { layer } from "../agents/agentPersonaDrafts.ts";

/**
 * The real drafts store on a database of its own, for tests of other behavior. Its library is the
 * test's `ServerConfig` state directory, or empty without one. By default nobody is in a Crew.
 */
export const agentPersonaDraftsTestLayer = (
  crews: Layer.Layer<AgentCrewInstanceService> = Layer.mock(AgentCrewInstanceService)({
    findMembership: () => Effect.succeed(null),
    read: () => Effect.succeed(null),
  }),
) =>
  layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.effectDiscard(createDraftTable).pipe(
          Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
        ),
        crews,
      ),
    ),
    // A test database that fails to open is a broken test, not an outcome a test checks.
    Layer.orDie,
  );
