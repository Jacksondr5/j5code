#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

import { ControlledParentSeedInput, runControlledParentSeed } from "../ControlledParentSeed.ts";

const decodeInput = Schema.decodeUnknownEffect(ControlledParentSeedInput);

export const seedControlledParentCommand = Command.make(
  "j5-a2a-seed-controlled-parent",
  {
    baseDir: Flag.string("base-dir"),
    squadronId: Flag.string("squadron-id"),
    squadronName: Flag.string("squadron-name"),
    participantId: Flag.string("participant-id"),
    threadId: Flag.string("thread-id"),
    createdAt: Flag.string("created-at"),
    homeCommandId: Flag.string("home-command-id"),
    placementCommandId: Flag.string("placement-command-id"),
    placementRequestFingerprint: Flag.string("placement-request-fingerprint"),
  },
  (flags) =>
    decodeInput({
      baseDir: flags.baseDir,
      squadron: {
        id: flags.squadronId,
        name: flags.squadronName,
        createdAt: flags.createdAt,
      },
      participantId: flags.participantId,
      threadId: flags.threadId,
      homeCommandId: flags.homeCommandId,
      placementCommandId: flags.placementCommandId,
      placementRequestFingerprint: flags.placementRequestFingerprint,
    }).pipe(
      Effect.flatMap(runControlledParentSeed),
      Effect.flatMap((result) => Console.log(JSON.stringify(result, null, 2))),
    ),
).pipe(
  Command.withDescription(
    "Atomically seed one controlled root A2A parent in an isolated T3 SQLite home.",
  ),
);

if (import.meta.main) {
  Command.run(seedControlledParentCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
