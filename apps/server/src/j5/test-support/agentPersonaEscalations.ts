import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AgentCrewInstanceService } from "../a2a/AgentCrewInstanceService.ts";
import createEscalationTable from "../a2a/migrations/053_PersonaEscalations.ts";
import { layer } from "../agents/agentPersonaEscalation.ts";

/**
 * The real escalation store on a database of its own, for tests of other behavior. Pass the Crew
 * store a test reads Captains from; by default nobody is in a Crew.
 */
export const agentPersonaEscalationsTestLayer = (
  crews: Layer.Layer<AgentCrewInstanceService> = Layer.mock(AgentCrewInstanceService)({
    findMembership: () => Effect.succeed(null),
    read: () => Effect.succeed(null),
  }),
) =>
  layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.effectDiscard(createEscalationTable).pipe(
          Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
        ),
        crews,
      ),
    ),
    // A test database that fails to open is a broken test, not an outcome a test checks.
    Layer.orDie,
  );
