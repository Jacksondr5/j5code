import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { makeFailoverPlanner } from "../j5/failover/planUsageLimitFailover.ts";
import { CommandId, MessageId, type OrchestrationV2Command } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
): OrchestrationV2Command | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  // An already-expired window reported with a fresh failure cannot start a retry loop.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (recovery?.runId !== thread.latestRunId || recovery.resetAt !== thread.usageLimitResetAt) {
    if (!autoResume && (!snooze || resetMs <= nowMs)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt,
        autoResume,
        snooze: snooze && resetMs > nowMs,
      },
    };
  }
  if (
    !recovery.autoResume ||
    resetMs > nowMs ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

export const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const planFailover = yield* makeFailoverPlanner;
  const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  const probes = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  return Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const preferences = yield* settings.getSettings;
    const now = yield* DateTime.now;
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: preferences.autoResumeLimitedThreads,
      snooze: preferences.snoozeLimitedThreads,
      failover: preferences.usageLimitFailover.enabled,
    });
    const nowMs = DateTime.toEpochMillis(now);
    if (
      preferences.usageLimitFailover.enabled &&
      candidates.length > 0 &&
      Option.isSome(registry)
    ) {
      for (const instanceId of preferences.usageLimitFailover.subscriptionOnlyInstances) {
        const previous = (yield* Ref.get(probes)).get(instanceId);
        if (previous !== undefined && nowMs - previous < 60_000) continue;
        yield* Ref.update(probes, (values) => new Map(values).set(instanceId, nowMs));
        // The ordinary health refresh is demand-driven; recovery must work with no client connected.
        yield* registry.value.refreshInstance(instanceId).pipe(
          Effect.timeoutOption("15 seconds"),
          Effect.catchCause((cause) =>
            Effect.logWarning("j5.limit-failover.probe-failed", { instanceId, cause }),
          ),
        );
      }
    }
    for (const thread of candidates) {
      if (preferences.usageLimitFailover.enabled) {
        yield* Effect.gen(function* () {
          const projection = yield* projections.getThreadProjection(thread.id);
          const planned = yield* planFailover(projection, preferences.usageLimitFailover, nowMs);
          if (planned === null) return;
          if (projection.thread.providerInstanceId === planned.run.providerInstanceId) {
            const arm = limitRecoveryCommand(
              thread,
              preferences.autoResumeLimitedThreads,
              nowMs,
              preferences.snoozeLimitedThreads,
            );
            if (arm?.type === "thread.metadata.update") yield* threads.dispatch(arm);
          }
          const phase = planned.decision.phase === "suspended" ? "notice" : planned.decision.phase;
          yield* threads.dispatch({
            type: "thread.provider-failover",
            commandId: CommandId.make(
              `limit-failover:${thread.id}:${planned.run.id}:${phase}${planned.decision.phase === "suspended" ? `:${planned.decision.reason}` : ""}`,
            ),
            threadId: thread.id,
            failedRunId: planned.run.id,
            phase,
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logWarning("j5.limit-failover.dispatch-failed", {
                threadId: thread.id,
                cause,
              });
              if (thread.latestRunId !== null)
                yield* threads
                  .dispatch({
                    type: "thread.provider-failover",
                    commandId: CommandId.make(
                      `limit-failover:${thread.id}:${thread.latestRunId}:stalled`,
                    ),
                    threadId: thread.id,
                    failedRunId: thread.latestRunId,
                    phase: "notice",
                  })
                  .pipe(Effect.ignore);
            }),
          ),
        );
        continue;
      }
      const command = limitRecoveryCommand(
        thread,
        preferences.autoResumeLimitedThreads,
        nowMs,
        preferences.snoozeLimitedThreads,
      );
      if (command === null) continue;
      yield* threads.dispatch(command).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
);
