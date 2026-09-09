import type { Action, Run } from "@j5/workflow-contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type Definition } from "./Definition.ts";
import { type SchedulingRecord, type Store, WorkflowError } from "./Store.ts";

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
  readonly reconcile: (
    action: Action,
    run: Run,
    recordIdentity: (identity: string) => Effect.Effect<void, WorkflowError>,
  ) => Effect.Effect<ActionObservation, WorkflowError>;
  readonly interrupt: (action: Action, run: Run) => Effect.Effect<void, WorkflowError>;
}

/** A complete, cursor-rotated scheduling sweep with at most four workflows in flight. */
export const makeWorker = (
  store: Store,
  definitions: ReadonlyArray<Definition>,
  adapters: Readonly<Record<string, Adapter>>,
  owner: string,
  candidateIsCurrent: (run: Run) => Effect.Effect<boolean, WorkflowError> = () =>
    Effect.succeed(true),
) => {
  const isWorkflowError = Schema.is(WorkflowError);
  let schedulingCursor = 0;
  const definitionFor = (run: Pick<Run, "definitionId" | "definitionVersion">) =>
    definitions.find(
      (item) => item.id === run.definitionId && item.version === run.definitionVersion,
    );

  const processRecord = Effect.fn("WorkflowWorker.processRecord")(function* (
    record: SchedulingRecord,
    currentTime: Effect.Effect<number>,
  ) {
    const snapshot = yield* store.get(record.id);
    const definition = definitionFor(snapshot);
    if (snapshot.status === "cancelling") {
      for (const action of snapshot.actions.filter((item) => item.status === "cancelled")) {
        const adapter = adapters[action.adapter];
        if (!adapter)
          return yield* new WorkflowError({
            code: "invalid",
            detail: `Cannot interrupt missing adapter ${action.adapter}`,
          });
        yield* adapter.interrupt(action, snapshot).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Workflow action did not confirm interruption during cancellation", {
              workflowId: snapshot.id,
              actionId: action.id,
              error,
            }),
          ),
        );
      }
      const now = yield* currentTime;
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
      return true;
    }
    if (snapshot.status === "restarting" && snapshot.restart) {
      const failed = yield* Effect.gen(function* () {
        for (const actionId of snapshot.restart!.cleanupActionIds) {
          const action = snapshot.actions.find((item) => item.id === actionId);
          if (!action) continue;
          const adapter = adapters[action.adapter];
          if (!adapter) return `Cannot interrupt missing adapter ${action.adapter}`;
          const exit = yield* Effect.exit(adapter.interrupt(action, snapshot));
          if (exit._tag === "Failure") return `Reviewer cleanup failed: ${String(exit.cause)}`;
        }
        return null;
      });
      const latest = yield* store.get(snapshot.id);
      if (latest.status !== "restarting") return false;
      const now = yield* currentTime;
      if (failed) {
        yield* store.command(
          {
            commandId: `restart-cleanup-failed:${snapshot.id}:${snapshot.revision}`,
            runId: snapshot.id,
            expectedRevision: latest.revision,
            event: { type: "restart_cleanup_failed", cause: failed },
            now,
          },
          definitionFor(latest),
        );
        return true;
      }
      if (snapshot.restart.phase === "code_review" && !(yield* candidateIsCurrent(latest))) {
        yield* store.command(
          {
            commandId: `changed:${snapshot.id}:${latest.revision}`,
            runId: snapshot.id,
            expectedRevision: latest.revision,
            event: { type: "invalidate", cause: "Candidate code changed" },
            now,
          },
          definitionFor(latest),
        );
        return true;
      }
      yield* store.command(
        {
          commandId: `restart-ready:${snapshot.id}:${snapshot.revision}`,
          runId: snapshot.id,
          expectedRevision: latest.revision,
          event: { type: "restart_ready" },
          now,
        },
        definitionFor(latest),
      );
      return true;
    }
    if (!definition || definition.hash !== snapshot.definitionHash) {
      const now = yield* currentTime;
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
      return true;
    }
    let progressed = false;
    for (const action of snapshot.actions.filter((item) => item.status === "pending")) {
      const claim = yield* store.claim(action.id, owner, yield* currentTime);
      if (!claim) continue;
      const changed = yield* Effect.gen(function* () {
        const current = yield* store.get(snapshot.id);
        if (current.status !== "running") return false;
        const adapter = adapters[action.adapter];
        let observation: ActionObservation;
        const now = yield* currentTime;
        if (!adapter) {
          observation = {
            status: "blocked",
            cause: `Adapter unavailable: ${action.adapter}`,
            recovery: "retry",
          };
        } else if (now >= action.deadline) {
          yield* adapter.interrupt(action, current);
          observation = {
            status: "blocked",
            cause: `Attempt deadline expired: ${action.id}`,
            recovery: null,
            failureCategory: "action_deadline_expired",
          };
        } else {
          if (["commit", "push", "draft"].includes(action.phase)) {
            if (!(yield* candidateIsCurrent(current))) {
              const latest = yield* store.get(snapshot.id);
              yield* store.command(
                {
                  commandId: `changed:${action.id}:${latest.revision}`,
                  runId: latest.id,
                  expectedRevision: latest.revision,
                  event: { type: "invalidate", cause: "Candidate code changed" },
                  now: yield* currentTime,
                },
                definition,
              );
              return true;
            }
          }
          const heartbeat = Effect.gen(function* () {
            while (true) {
              const time = yield* currentTime;
              yield* Effect.sleep(Math.max(1, Math.min(20_000, action.deadline - time)));
              const renewedAt = yield* currentTime;
              if (renewedAt >= action.deadline) {
                yield* adapter.interrupt(action, current);
                return {
                  status: "blocked",
                  cause: `Attempt deadline expired: ${action.id}`,
                  recovery: null,
                  failureCategory: "action_deadline_expired",
                } as const;
              }
              const rows = yield* store.renew(claim, renewedAt);
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
                Effect.flatMap((recordedAt) => store.identity(claim, identity, recordedAt)),
                Effect.mapError((error) =>
                  isWorkflowError(error)
                    ? error
                    : new WorkflowError({ code: "storage", detail: String(error) }),
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
        if (observation.status === "pending") return false;
        const latest = yield* store.get(snapshot.id);
        if (
          observation.status === "completed" &&
          action.phase === "code_review" &&
          !(yield* candidateIsCurrent(latest))
        ) {
          yield* store.command(
            {
              commandId: `changed:${action.id}:${latest.revision}`,
              runId: latest.id,
              expectedRevision: latest.revision,
              event: { type: "invalidate", cause: "Candidate code changed" },
              now: yield* currentTime,
            },
            definition,
          );
          return true;
        }
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
        return true;
      }).pipe(Effect.ensuring(store.release(claim).pipe(Effect.orDie)));
      progressed ||= changed;
    }
    return progressed;
  });

  const processRange = Effect.fn("WorkflowWorker.processRange")(function* (
    after: number,
    through: number,
    currentTime: Effect.Effect<number>,
  ) {
    let cursor = after;
    let progressed = false;
    let firstSequence: number | undefined;
    while (cursor < through) {
      const batch = yield* store.activeBatch(cursor, through, 100);
      if (batch.length === 0) break;
      firstSequence ??= batch[0]!.creationSequence;
      const results = yield* Effect.forEach(
        batch,
        (record) =>
          processRecord(record, currentTime).pipe(
            Effect.catch((error) =>
              Effect.logError("Workflow failed during scheduling pass", {
                workflowId: record.id,
                error,
              }).pipe(Effect.as(false)),
            ),
          ),
        { concurrency: 4 },
      );
      progressed ||= results.some(Boolean);
      cursor = batch.at(-1)!.creationSequence;
    }
    return { progressed, firstSequence };
  });

  const runOnce = Effect.fn("WorkflowWorker.runOnce")(function* (requestedNow?: number) {
    const startedAt = yield* Clock.currentTimeMillis;
    const currentTime =
      requestedNow === undefined
        ? Clock.currentTimeMillis
        : Clock.currentTimeMillis.pipe(
            Effect.map((observedAt) => requestedNow + observedAt - startedAt),
          );
    const maximum = yield* store.activeMaxSequence();
    if (maximum === 0) return false;
    const start = schedulingCursor > 0 && schedulingCursor < maximum ? schedulingCursor : 0;
    const tail = yield* processRange(start, maximum, currentTime);
    const head = start > 0 ? yield* processRange(0, start, currentTime) : undefined;
    const firstSequence = tail.firstSequence ?? head?.firstSequence;
    if (firstSequence !== undefined) schedulingCursor = firstSequence;
    return tail.progressed || (head?.progressed ?? false);
  });

  const drain = Effect.fn("WorkflowWorker.drain")(function* (requestedNow?: number) {
    while (yield* runOnce(requestedNow)) {
      // Durable state, rather than elapsed time, determines when the sweep is complete.
    }
  });

  return { runOnce, drain };
};
