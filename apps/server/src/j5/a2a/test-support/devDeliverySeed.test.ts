import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Logger from "effect/Logger";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  DevDeliverySeedArgumentError,
  parseDevDeliverySeedArgs,
  runDevDeliverySeed,
  validateIsolatedBaseDir,
  verifyDevDeliverySeedRollback,
} from "./devDeliverySeed.ts";

it.effect("requires an explicit isolated base and emits a provider-safe receipt", () =>
  Effect.gen(function* () {
    const missingBaseDirError = (() => {
      try {
        parseDevDeliverySeedArgs([]);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    assert.instanceOf(missingBaseDirError, DevDeliverySeedArgumentError);
    const sharedStateError = (() => {
      try {
        validateIsolatedBaseDir(resolve(homedir(), ".t3", "userdata"));
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    assert.instanceOf(sharedStateError, DevDeliverySeedArgumentError);
    const baseDir = mkdtempSync(join(tmpdir(), "j5-a2a-dev-delivery-seed-test-"));
    try {
      assert.equal(validateIsolatedBaseDir(baseDir), realpathSync(baseDir));
      yield* verifyDevDeliverySeedRollback(baseDir).pipe(
        Effect.provide(Logger.layer([], { mergeWithExisting: false })),
      );
      const receipt = yield* runDevDeliverySeed(baseDir).pipe(
        Effect.provide(Logger.layer([], { mergeWithExisting: false })),
      );
      assert.isTrue(
        receipt.scenarios.ta1PeerExchange.deliveryMessageId.startsWith("message:j5:a2a:delivery:"),
      );
      assert.isTrue(
        receipt.scenarios.ta3Silence.noticeDeliveryMessageId.startsWith("message:j5:a2a:delivery:"),
      );
      assert.isTrue(
        receipt.scenarios.rawFutureEnvelope.deliveryMessageId.startsWith(
          "message:j5:a2a:delivery:",
        ),
      );
      assert.isTrue(receipt.scenarios.normalNonA2AContrast.messageId.startsWith("message:mcp:"));
      assert.equal(receipt.noProviderWork.runnerStartedEffectWorker, false);
      assert.equal(receipt.noProviderWork.providerAdapterOpenSessionCalls, 0);
      assert.equal(receipt.noProviderWork.activeProviderSessionCount, 0);
      assert.equal(receipt.noProviderWork.activeRunCount, 0);
      assert.equal(receipt.noProviderWork.cancelledProviderStartEffectCount, 5);
      assert.equal(receipt.noProviderWork.nextClaimableAt, null);
      assert.equal(receipt.notSeeded.ta2HumanAnswer.status, "deferred-not-implemented-this-runner");
      assert.equal(receipt.notSeeded.ta4Trailing.status, "held");
      const lock = new DatabaseSync(receipt.dbPath);
      lock.exec("BEGIN IMMEDIATE");
      try {
        const locked = yield* Effect.exit(
          runDevDeliverySeed(baseDir).pipe(
            Effect.provide(Logger.layer([], { mergeWithExisting: false })),
          ),
        );
        assert.equal(locked._tag, "Failure");
        if (locked._tag === "Failure") {
          assert.include(
            Cause.pretty(locked.cause),
            "could not acquire its rollback write preflight",
          );
        }
      } finally {
        lock.exec("ROLLBACK");
        lock.close();
      }
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  }),
);
