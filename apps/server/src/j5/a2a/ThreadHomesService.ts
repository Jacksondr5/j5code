import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { A2AHomeRegistrar } from "./HomeRegistrar.ts";
import { SquadronId } from "./contracts.ts";

const SquadronHome = Schema.Struct({
  id: SquadronId,
  name: Schema.String.check(
    Schema.makeFilter((name) => name.trim().length > 0 || "Squadron name must not be blank."),
  ),
});

export const ThreadHome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("known"), squadron: SquadronHome }),
  Schema.Struct({ kind: Schema.Literal("unknown") }),
]);
export type ThreadHome = typeof ThreadHome.Type;

export const ThreadHomeEntry = Schema.Struct({
  threadId: ThreadId,
  home: ThreadHome,
});
export type ThreadHomeEntry = typeof ThreadHomeEntry.Type;

/** A sidebar-visible thread set is resolved in one total, opaque batch request. */
export const ThreadHomesRequest = Schema.Struct({
  threadIds: Schema.Array(ThreadId),
});
export type ThreadHomesRequest = typeof ThreadHomesRequest.Type;

export const ThreadHomesResponse = Schema.Struct({
  entries: Schema.Array(ThreadHomeEntry),
});
export type ThreadHomesResponse = typeof ThreadHomesResponse.Type;

export type ThreadHomesError = SqlError;

export interface ThreadHomesShape {
  /**
   * Resolves immutable Registrar homes, not project associations or active
   * membership. Entries are total and first-occurrence ordered.
   */
  readonly threadHomes: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<ThreadHomesResponse, ThreadHomesError>;
}

export class ThreadHomesService extends Context.Service<ThreadHomesService, ThreadHomesShape>()(
  "t3/j5/a2a/ThreadHomesService",
) {}

const uniqueInFirstOccurrenceOrder = <Value>(values: ReadonlyArray<Value>) =>
  Array.from(new Set(values));

export const layer: Layer.Layer<ThreadHomesService, never, A2AHomeRegistrar> = Layer.effect(
  ThreadHomesService,
  Effect.gen(function* () {
    const registrar = yield* A2AHomeRegistrar;

    const threadHomes: ThreadHomesShape["threadHomes"] = (threadIds) =>
      registrar
        .getHomesForThreads(uniqueInFirstOccurrenceOrder(threadIds))
        .pipe(Effect.map((entries) => ({ entries }) satisfies ThreadHomesResponse));

    return ThreadHomesService.of({ threadHomes });
  }),
);
