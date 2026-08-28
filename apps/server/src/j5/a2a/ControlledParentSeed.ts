// @effect-diagnostics nodeBuiltinImport:off - node:os resolves the shared T3 home guard.
import * as NodeOS from "node:os";

import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { CommCommandId, ParticipantId, Squadron } from "./contracts.ts";
import { PlacementCommandId } from "./placementContracts.ts";

const NonEmptyString = Schema.String.check(Schema.isNonEmpty());
const StoredAgentParticipant = Schema.Struct({
  kind: Schema.Literal("agent"),
  id: ParticipantId,
  threadId: ThreadId,
});
const encodeParticipant = Schema.encodeEffect(Schema.fromJsonString(StoredAgentParticipant));
const encodeJoinedPayload = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ participant: StoredAgentParticipant })),
);

export const ControlledParentSeedInput = Schema.Struct({
  baseDir: NonEmptyString,
  squadron: Squadron,
  participantId: ParticipantId,
  threadId: ThreadId,
  homeCommandId: CommCommandId,
  placementCommandId: PlacementCommandId,
  placementRequestFingerprint: NonEmptyString,
});
export type ControlledParentSeedInput = typeof ControlledParentSeedInput.Type;

export interface ControlledParentSeedResult {
  readonly database: string;
  readonly backup: string;
  readonly squadronId: ControlledParentSeedInput["squadron"]["id"];
  readonly participantId: ParticipantId;
  readonly homeEventSeq: 1;
  readonly placementEventSeq: 1;
}

export interface RunControlledParentSeedOptions {
  readonly sharedHome?: string | undefined;
  /** Additional in-transaction validation, run only after all six writes. */
  readonly afterWrites?:
    | Effect.Effect<void, ControlledParentSeedAfterWritesError | SqlError, SqlClient.SqlClient>
    | undefined;
}

export class ControlledParentSeedAfterWritesError extends Schema.TaggedErrorClass<ControlledParentSeedAfterWritesError>()(
  "ControlledParentSeedAfterWritesError",
  { reason: NonEmptyString },
) {}

export class ControlledParentSeedDatabaseMissingError extends Schema.TaggedErrorClass<ControlledParentSeedDatabaseMissingError>()(
  "ControlledParentSeedDatabaseMissingError",
  { databasePath: Schema.String },
) {
  override get message(): string {
    return `Database does not exist at '${this.databasePath}'. Start the isolated T3 home once to run migrations.`;
  }
}

export class ControlledParentSeedSharedHomeMutationError extends Schema.TaggedErrorClass<ControlledParentSeedSharedHomeMutationError>()(
  "ControlledParentSeedSharedHomeMutationError",
  {},
) {
  override get message(): string {
    return "Refusing to seed the shared ~/.t3 database. Use an isolated --base-dir.";
  }
}

export class ControlledParentSeedDatabaseError extends Schema.TaggedErrorClass<ControlledParentSeedDatabaseError>()(
  "ControlledParentSeedDatabaseError",
  {
    databasePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to seed the controlled A2A parent in SQLite database '${this.databasePath}'.`;
  }
}

const decodeInput = Schema.decodeUnknownEffect(ControlledParentSeedInput);

/**
 * Seeds the fixed parent used by the isolated A6 proof. All domain rows are
 * inserted through one transaction; this deliberately does not compose the
 * independently transactional ledger, registrar, or placement services.
 */
export const runControlledParentSeed = Effect.fn("j5.a2a.runControlledParentSeed")(function* (
  untrustedInput: ControlledParentSeedInput,
  options: RunControlledParentSeedOptions = {},
) {
  const input = yield* decodeInput(untrustedInput);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = path.resolve(input.baseDir);
  const sharedHome = path.resolve(options.sharedHome ?? path.join(NodeOS.homedir(), ".t3"));
  const databasePath = path.join(baseDir, "userdata", "state.sqlite");

  if (!(yield* fs.exists(databasePath))) {
    return yield* new ControlledParentSeedDatabaseMissingError({ databasePath });
  }
  const [canonicalBaseDir, canonicalSharedHome] = yield* Effect.all([
    fs.realPath(baseDir),
    fs.realPath(sharedHome).pipe(Effect.orElseSucceed(() => sharedHome)),
  ]);
  if (canonicalBaseDir === canonicalSharedHome) {
    return yield* new ControlledParentSeedSharedHomeMutationError();
  }

  const program = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("PRAGMA busy_timeout = 5000").unprepared;

    const timestamp = DateTime.formatIso(yield* DateTime.now).replaceAll(":", "-");
    const backupPath = `${databasePath}.backup-${timestamp}`;
    yield* sql`VACUUM INTO ${backupPath}`;
    yield* fs.chmod(backupPath, 0o600);

    const participant = {
      kind: "agent" as const,
      id: input.participantId,
      threadId: input.threadId,
    };
    const participantPayload = yield* encodeJoinedPayload({ participant });
    const membershipPayload = yield* encodeParticipant(participant);

    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
            INSERT INTO j5_a2a_squadron (id, name, created_at)
            VALUES (${input.squadron.id}, ${input.squadron.name}, ${input.squadron.createdAt})
          `;
        yield* sql`
            INSERT INTO j5_a2a_comm_event (
              seq,
              squadron_id,
              kind,
              sender,
              receiver,
              exchange_id,
              correlation_id,
              payload,
              created_at,
              command_id
            ) VALUES (
              1,
              ${input.squadron.id},
              'participant.joined',
              NULL,
              ${input.participantId},
              NULL,
              NULL,
              ${participantPayload},
              ${input.squadron.createdAt},
              ${input.homeCommandId}
            )
          `;
        yield* sql`
            INSERT INTO j5_a2a_comm_command_receipt (
              command_id,
              squadron_id,
              command_type,
              accepted_at,
              result_seq
            ) VALUES (
              ${input.homeCommandId},
              ${input.squadron.id},
              'comm.append',
              ${input.squadron.createdAt},
              1
            )
          `;
        yield* sql`
            INSERT INTO j5_a2a_squadron_membership (
              squadron_id,
              participant_id,
              participant_kind,
              thread_id,
              joined_seq,
              updated_seq,
              payload
            ) VALUES (
              ${input.squadron.id},
              ${input.participantId},
              'agent',
              ${input.threadId},
              1,
              1,
              ${membershipPayload}
            )
          `;
        yield* sql`
            INSERT INTO j5_a2a_placement_event (
              seq,
              command_id,
              request_fingerprint,
              squadron_id,
              participant_id,
              kind,
              actor,
              actor_session_id,
              actor_subject,
              auth_method,
              provenance_kind,
              provenance_participant_id,
              provenance_source,
              previous_parent_id,
              placement_parent_id,
              created_at
            ) VALUES (
              1,
              ${input.placementCommandId},
              ${input.placementRequestFingerprint},
              ${input.squadron.id},
              ${input.participantId},
              'participant.placement_created',
              'platform',
              NULL,
              NULL,
              NULL,
              'unknown',
              NULL,
              NULL,
              NULL,
              NULL,
              ${input.squadron.createdAt}
            )
          `;
        yield* sql`
            INSERT INTO j5_a2a_participant_placement (
              squadron_id,
              participant_id,
              provenance_kind,
              provenance_participant_id,
              provenance_source,
              placement_parent_id,
              created_event_seq,
              updated_event_seq
            ) VALUES (
              ${input.squadron.id},
              ${input.participantId},
              'unknown',
              NULL,
              NULL,
              NULL,
              1,
              1
            )
          `;
        yield* options.afterWrites ?? Effect.void;
      }),
    );

    return {
      database: databasePath,
      backup: backupPath,
      squadronId: input.squadron.id,
      participantId: input.participantId,
      homeEventSeq: 1,
      placementEventSeq: 1,
    } satisfies ControlledParentSeedResult;
  });

  return yield* program.pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: databasePath })),
    Effect.mapError((cause) => new ControlledParentSeedDatabaseError({ databasePath, cause })),
  );
});
