import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";

import {
  DevDeliverySeedArgumentError,
  parseDevDeliverySeedArgs,
  runDevDeliverySeed,
  validateIsolatedBaseDir,
  verifyDevDeliverySeedRollback,
} from "./devDeliverySeed.ts";

const isDevDeliverySeedArgumentError = Schema.is(DevDeliverySeedArgumentError);

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
    assert.isTrue(isDevDeliverySeedArgumentError(missingBaseDirError));
    const fileSystem = yield* FileSystem.FileSystem;
    const fakeHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "j5-a2a-home-" });
    const originalHome = process.env.HOME;
    try {
      process.env.HOME = fakeHome;
      for (const name of [".t3", ".j5code"]) {
        const sharedHome = `${fakeHome}/${name}`;
        yield* fileSystem.makeDirectory(sharedHome, { recursive: true });
        const sharedStateError = yield* Effect.flip(
          validateIsolatedBaseDir(`${sharedHome}/userdata`),
        );
        assert.isTrue(isDevDeliverySeedArgumentError(sharedStateError));
        assert.include(sharedStateError.message, name);
      }
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
    const baseDir = yield* fileSystem.makeTempDirectory({
      directory: NodeOS.tmpdir(),
      prefix: "j5-a2a-dev-delivery-seed-test-",
    });
    try {
      assert.equal(yield* validateIsolatedBaseDir(baseDir), yield* fileSystem.realPath(baseDir));
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
      yield* fileSystem.remove(baseDir, { recursive: true, force: true }).pipe(Effect.ignore);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
