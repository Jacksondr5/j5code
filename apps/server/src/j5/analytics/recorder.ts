import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { AnalyticsService } from "../../telemetry/AnalyticsService.ts";

/**
 * Records a J5 analytics event from inside a service that has other work to do. The server's
 * graph always has the analytics service; a graph without one (most unit layers) records
 * nothing, so a service does not need it to be built.
 */
export const j5AnalyticsRecorder = Effect.serviceOption(AnalyticsService).pipe(
  Effect.map(
    (analytics) =>
      (event: `j5.${string}`, properties: Readonly<Record<string, unknown>>): Effect.Effect<void> =>
        Option.isSome(analytics) ? analytics.value.record(event, properties) : Effect.void,
  ),
);

/** Milliseconds between two ISO timestamps, or nothing when either does not parse. */
export const durationMsBetween = (
  startedAt: string,
  endedAt: string,
): { readonly durationMs?: number } => {
  const started = DateTime.make(startedAt);
  const ended = DateTime.make(endedAt);
  return Option.isSome(started) && Option.isSome(ended)
    ? {
        durationMs: Math.max(
          0,
          DateTime.toEpochMillis(ended.value) - DateTime.toEpochMillis(started.value),
        ),
      }
    : {};
};
