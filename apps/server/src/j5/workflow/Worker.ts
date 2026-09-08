import type { Action, Run } from "@j5/workflow-contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import { type Definition } from "./Definition.ts";
import { type Store, WorkflowError } from "./Store.ts";

export type ActionObservation =
  | { readonly status: "pending" }
  | { readonly status: "completed"; readonly output: unknown }
  | {
      readonly status: "blocked";
      readonly cause: string;
      readonly recovery: Run["recovery"];
      readonly failureCategory?: NonNullable<Run["failureCategory"]>;
    };

export interface Adapter {
  readonly recovery: "reconcile" | "inspect";
  /** Called on first execution and restart with the same durable action id. */
  readonly reconcile: (
    action: Action,
    run: Run,
    recordIdentity: (identity: string) => Effect.Effect<void, WorkflowError>,
  ) => Effect.Effect<ActionObservation, WorkflowError>;
  readonly interrupt: (action: Action, run: Run) => Effect.Effect<void, WorkflowError>;
}

/** One bounded scheduling pass. The server owns its lifetime, independently of HTTP clients. */
export const makeWorker = (
  store: Store,
  definitions: ReadonlyArray<Definition>,
  adapters: Readonly<Record<string, Adapter>>,
  owner: string,
) => {
  const definitionFor = (run: Run) =>
    definitions.find(
      (item) => item.id === run.definitionId && item.version === run.definitionVersion,
    );
  const runOnce = Effect.fn("WorkflowWorker.runOnce")(function* (now: number) {
    const started = yield* Clock.currentTimeMillis;
    const currentTime = Clock.currentTimeMillis.pipe(Effect.map((time) => now + time - started));
    let progressed = false;
    for (const snapshot of yield* store.active()) {
      const definition = definitionFor(snapshot);
      if (snapshot.status === "cancelling") {
        for (const action of snapshot.actions.filter((item) => item.status === "cancelled")) {
          const adapter = adapters[action.adapter];
          if (!adapter)
            return yield* new WorkflowError({
              code: "invalid",
              detail: `Cannot interrupt missing adapter ${action.adapter}`,
            });
          yield* adapter.interrupt(action, snapshot);
        }
        yield* store.command(
          {
            commandId: `cancelled:${snapshot.id}:${snapshot.revision}`,
            runId: snapshot.id,
            expectedRevision: snapshot.revision,
            event: { type: "cancelled" },
            now,
          },
          definition,
        );
        progressed = true;
        continue;
      }
      if (!definition || definition.hash !== snapshot.definitionHash) {
        yield* store.command(
          {
            commandId: `recover:${snapshot.id}:${snapshot.revision}`,
            runId: snapshot.id,
            expectedRevision: snapshot.revision,
            event: { type: "recover" },
            now,
          },
          definition,
        );
        progressed = true;
        continue;
      }
      for (const action of snapshot.actions.filter((item) => item.status === "pending")) {
        const claim = yield* store.claim(action.id, owner, yield* currentTime);
        if (!claim) continue;
        yield* Effect.gen(function* () {
          const current = yield* store.get(snapshot.id);
          if (current.status !== "running") return;
          const adapter = adapters[action.adapter];
          let observation: ActionObservation;
          if (!adapter)
            observation = {
              status: "blocked",
              cause: `Adapter unavailable: ${action.adapter}`,
              recovery: "retry",
            };
          else if ((yield* currentTime) >= action.deadline) {
            yield* adapter.interrupt(action, current);
            observation = {
              status: "blocked",
              cause: `Attempt deadline expired: ${action.id}`,
              recovery: null,
              failureCategory: "action_deadline_expired",
            };
          } else {
            const heartbeat = Effect.gen(function* () {
              while (true) {
                yield* Effect.sleep(
                  Math.max(1, Math.min(20_000, action.deadline - (yield* currentTime))),
                );
                if ((yield* currentTime) >= action.deadline) {
                  yield* adapter.interrupt(action, current);
                  return {
                    status: "blocked",
                    cause: `Attempt deadline expired: ${action.id}`,
                    recovery: null,
                    failureCategory: "action_deadline_expired",
                  } as const;
                }
                const rows = yield* store.renew(claim, yield* currentTime);
                if (!rows.length) {
                  yield* adapter.interrupt(action, current);
                  return yield* new WorkflowError({
                    code: "conflict",
                    detail: "Worker lease was lost",
                  });
                }
              }
            });
            observation = yield* adapter
              .reconcile(action, current, (identity) =>
                currentTime.pipe(
                  Effect.flatMap((time) => store.identity(claim, identity, time)),
                  Effect.mapError(
                    (error) => new WorkflowError({ code: "storage", detail: String(error) }),
                  ),
                ),
              )
              .pipe(
                Effect.raceFirst(heartbeat),
                Effect.mapError(
                  (error) => new WorkflowError({ code: "invalid", detail: String(error) }),
                ),
                Effect.catch((error) =>
                  Effect.succeed({
                    status: "blocked" as const,
                    cause: error.detail,
                    recovery:
                      adapter.recovery === "reconcile"
                        ? ("retry" as const)
                        : ("inspect_external_result" as const),
                  }),
                ),
              );
          }
          if (observation.status === "pending") return;
          const latest = yield* store.get(snapshot.id);
          yield* store.command(
            {
              commandId: `action:${action.id}:${latest.revision}`,
              runId: snapshot.id,
              expectedRevision: latest.revision,
              claim,
              now: yield* currentTime,
              event:
                observation.status === "completed"
                  ? { type: "result", actionId: action.id, output: observation.output }
                  : {
                      type: "block",
                      actionId: action.id,
                      cause: observation.cause,
                      recovery: observation.recovery,
                      ...(observation.failureCategory
                        ? { failureCategory: observation.failureCategory }
                        : {}),
                    },
            },
            definition,
          );
          progressed = true;
        }).pipe(Effect.ensuring(store.release(claim).pipe(Effect.orDie)));
      }
    }
    return progressed;
  });
  const drain = Effect.fn("WorkflowWorker.drain")(function* (now: number) {
    while (yield* runOnce(now)) {
      /* All tests wait on durable transitions, not timing. */
    }
  });
  return { runOnce, drain };
};
