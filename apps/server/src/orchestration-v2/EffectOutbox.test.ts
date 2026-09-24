import { assert, it } from "@effect/vitest";
import { CommandId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { EffectOutboxV2, layer } from "./EffectOutbox.ts";

const TestLayer = layer.pipe(Layer.provide(SqlitePersistenceMemory));

for (const outcome of ["succeeded", "failed", "cancelled", "process-loss"] as const) {
  it.effect(`awaits ${outcome} durably for concurrent and later subscribers`, () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutboxV2;
      const effectId = `effect:${outcome}`;
      const threadId = ThreadId.make(`thread:${outcome}`);
      yield* outbox.enqueue([
        {
          id: effectId,
          commandId: CommandId.make(`command:${outcome}`),
          threadId,
          request: { type: "provider-turn.start", runId: RunId.make(`run:${outcome}`) },
        },
      ]);
      const first = yield* outbox
        .awaitSettled(effectId)
        .pipe(Effect.forkChild({ startImmediately: true }));
      const second = yield* outbox
        .awaitSettled(effectId)
        .pipe(Effect.forkChild({ startImmediately: true }));
      const claim = yield* outbox.claimNext({ workerId: "test", leaseDurationMs: 30_000 });
      assert.isTrue(Option.isSome(claim));
      // A retry is not a delivery outcome; both subscribers must keep waiting.
      yield* outbox.retry({ effectId, workerId: "test", error: "retryable", delayMs: 0 });
      assert.isUndefined(first.pollUnsafe());
      assert.isUndefined(second.pollUnsafe());
      yield* outbox.claimNext({ workerId: "test", leaseDurationMs: 30_000 });
      if (outcome === "succeeded") {
        yield* outbox.succeed({ effectId, workerId: "test" });
      } else if (outcome === "failed") {
        yield* outbox.fail({ effectId, workerId: "test", error: "not delivered" });
      } else if (outcome === "cancelled") {
        const ids = yield* outbox.cancelUnsettled({
          threadId,
          effectTypes: ["provider-turn.start"],
          reason: "archived",
        });
        yield* outbox.signalCancellations(ids);
      } else {
        yield* outbox.reconcileAfterProcessLoss;
      }
      const expected = outcome === "process-loss" ? "cancelled" : outcome;
      assert.equal((yield* Fiber.join(first)).status, expected);
      assert.equal((yield* Fiber.join(second)).status, expected);
      assert.equal((yield* outbox.awaitSettled(effectId)).status, expected);
    }).pipe(Effect.provide(TestLayer)),
  );
}

it.effect("fails for a missing effect instead of waiting forever", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutboxV2;
    const error = yield* Effect.flip(outbox.awaitSettled("missing"));
    assert.equal(error.operation, "await-settled");
  }).pipe(Effect.provide(TestLayer)),
);
