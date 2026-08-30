import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Logger from "effect/Logger";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

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
        validateIsolatedBaseDir(NodePath.resolve(NodeOS.homedir(), ".t3", "userdata"));
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    assert.instanceOf(sharedStateError, DevDeliverySeedArgumentError);
    const baseDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "j5-a2a-dev-delivery-seed-test-"),
    );
    try {
      assert.equal(validateIsolatedBaseDir(baseDir), NodeFS.realpathSync(baseDir));
      yield* verifyDevDeliverySeedRollback(baseDir).pipe(
        Effect.provide(Logger.layer([], { mergeWithExisting: false })),
      );
      const receipt = yield* runDevDeliverySeed(baseDir).pipe(
        Effect.provide(Logger.layer([], { mergeWithExisting: false })),
      );
      assert.isTrue(
        receipt.scenarios.ta1PeerExchange.deliveryMessageId.startsWith("message:j5:a2a:delivery:"),
      );
      assert.match(receipt.scenarios.ta2HumanAnswer.personId, /^human:/);
      assert.isTrue(
        receipt.scenarios.ta2HumanAnswer.replyDeliveryMessageId.startsWith(
          "message:j5:a2a:delivery:",
        ),
      );
      assert.equal(
        receipt.scenarios.ta2HumanAnswer.targetThreadId,
        receipt.threads.sender.threadId,
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
      assert.equal(receipt.noProviderWork.cancelledProviderStartEffectCount, 6);
      assert.equal(receipt.noProviderWork.nextClaimableAt, null);
      assert.equal(receipt.notSeeded.ta4Trailing.status, "held");
      const lock = new NodeSqlite.DatabaseSync(receipt.dbPath);
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
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  }),
);
