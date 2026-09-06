import { describe, expect, it } from "@effect/vitest";
import { OrchestrationV2ThreadShellSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { OrchestratorV2 } from "../Orchestrator.ts";
import { runOrchestratorV2Scenario } from "./OrchestratorScenario.ts";
import { makeProviderReplayGate } from "./ProviderReplayGate.testkit.ts";

const orchestrator = Layer.mock(OrchestratorV2)({
  streamStoredEvents: Stream.empty,
  getShellSnapshot: () =>
    Effect.succeed(
      OrchestrationV2ThreadShellSnapshot.make({
        schemaVersion: 1,
        snapshotSequence: 0,
        threads: [],
        archivedThreads: [],
      }),
    ),
});

describe("replay gate scenario steps", () => {
  it.effect("waits for provider arrival without spending event-loop attempts", () =>
    Effect.gen(function* () {
      const label = "turn/completed";
      const gate = makeProviderReplayGate([label]);
      const subscribed = Promise.withResolvers<void>();
      const scenario = yield* runOrchestratorV2Scenario(
        { name: "held-provider", commands: [], steps: [{ type: "release_replay_gate", label }] },
        {
          replayGate: {
            ...gate,
            hasReached: () => {
              throw new Error("The scenario must await arrival, not poll for it.");
            },
            waitUntilReached: (requestedLabel) => {
              subscribed.resolve();
              return gate.waitUntilReached(requestedLabel);
            },
          },
        },
      ).pipe(Effect.provide(orchestrator), Effect.forkScoped);

      yield* Effect.raceFirst(
        Effect.promise(() => subscribed.promise),
        Fiber.join(scenario).pipe(
          Effect.andThen(
            Effect.die(new Error("The scenario completed before the provider arrived.")),
          ),
        ),
      );
      expect(gate.hasReached(label)).toBe(false);
      const emitting = gate.beforeEmit(label);
      yield* Fiber.join(scenario);
      yield* Effect.promise(() => emitting);
      expect(gate.release(label)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a release step for an undeclared gate", () =>
    Effect.gen(function* () {
      const result = yield* runOrchestratorV2Scenario(
        {
          name: "missing-gate",
          commands: [],
          steps: [{ type: "release_replay_gate", label: "missing" }],
        },
        { replayGate: makeProviderReplayGate([]) },
      ).pipe(Effect.flip, Effect.provide(orchestrator));
      expect(result).toMatchObject({
        _tag: "OrchestratorV2ScenarioStepError",
        step: "release_replay_gate:missing:reached=false",
      });
    }),
  );
});
