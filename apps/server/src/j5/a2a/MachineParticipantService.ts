import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { A2ALedger, A2AStorageError, type A2ALedgerError } from "./LedgerService.ts";
import {
  type CommCommandId,
  machineParticipantIdForName,
  ParticipantId,
  SquadronId,
} from "./contracts.ts";

/**
 * Registered machine senders: cron jobs, watchdogs and scripts that talk to the
 * fleet from outside any agent session. A machine has one immutable Squadron
 * home like an agent, but no thread: it sends plain messages and never
 * receives. Its `participant.joined` event is the ledger fact; the table read
 * here is that fact's projection.
 */

/** Server-unique, shell-friendly: the part after `machine:`. */
export const MACHINE_PARTICIPANT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface MachineParticipantRecord {
  readonly participantId: ParticipantId;
  readonly squadronId: SquadronId;
  readonly squadronName: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface RegisterMachineParticipantInput {
  readonly commandId: CommCommandId;
  readonly squadronId: SquadronId;
  readonly name: string;
  readonly acceptedAt: string;
}

export class MachineParticipantInvalidNameError extends Schema.TaggedErrorClass<MachineParticipantInvalidNameError>()(
  "MachineParticipantInvalidNameError",
  { name: Schema.String },
) {
  override get message(): string {
    return `Machine participant name "${this.name}" is invalid. Use 1-64 lowercase letters, digits, or hyphens, starting with a letter or digit.`;
  }
}

export class MachineParticipantNameTakenError extends Schema.TaggedErrorClass<MachineParticipantNameTakenError>()(
  "MachineParticipantNameTakenError",
  {
    participantId: Schema.String,
    existingSquadronId: Schema.String,
    requestedSquadronId: Schema.String,
  },
) {
  override get message(): string {
    return `Machine participant ${this.participantId} already has immutable home ${this.existingSquadronId}; registration requested ${this.requestedSquadronId}. Choose another name, or reuse the existing participant.`;
  }
}

export class MachineParticipantNotFoundError extends Schema.TaggedErrorClass<MachineParticipantNotFoundError>()(
  "MachineParticipantNotFoundError",
  { participantId: Schema.String },
) {
  override get message(): string {
    return `Machine participant ${this.participantId} is not registered. Register it with \`j5 a2a participant create --squadron <id> --name <name>\`.`;
  }
}

export type MachineParticipantError =
  | A2ALedgerError
  | SqlError
  | MachineParticipantInvalidNameError
  | MachineParticipantNameTakenError
  | MachineParticipantNotFoundError;

export interface MachineParticipantServiceShape {
  /** Idempotent: the same name in the same Squadron returns the existing record with `created: false`. */
  readonly register: (
    input: RegisterMachineParticipantInput,
  ) => Effect.Effect<
    { readonly participant: MachineParticipantRecord; readonly created: boolean },
    MachineParticipantError
  >;
  readonly resolve: (
    participantId: ParticipantId,
  ) => Effect.Effect<MachineParticipantRecord, SqlError | MachineParticipantNotFoundError>;
  readonly list: () => Effect.Effect<ReadonlyArray<MachineParticipantRecord>, SqlError>;
}

export class MachineParticipantService extends Context.Service<
  MachineParticipantService,
  MachineParticipantServiceShape
>()("t3/j5/a2a/MachineParticipantService") {}

interface MachineRow {
  readonly participant_id: string;
  readonly squadron_id: string;
  readonly squadron_name: string;
  readonly name: string;
  readonly created_at: string;
}

const recordFromRow = (row: MachineRow): MachineParticipantRecord => ({
  participantId: ParticipantId.make(row.participant_id),
  squadronId: SquadronId.make(row.squadron_id),
  squadronName: row.squadron_name,
  name: row.name,
  createdAt: row.created_at,
});

export const layer: Layer.Layer<MachineParticipantService, never, A2ALedger | SqlClient.SqlClient> =
  Layer.effect(
    MachineParticipantService,
    Effect.gen(function* () {
      const ledger = yield* A2ALedger;
      const sql = yield* SqlClient.SqlClient;

      const readRow = Effect.fn("j5.a2a.machine.readRow")(function* (participantId: ParticipantId) {
        const rows = yield* sql<MachineRow>`
          SELECT
            machine.participant_id,
            machine.squadron_id,
            squadron.name AS squadron_name,
            machine.name,
            machine.created_at
          FROM j5_a2a_machine_participant AS machine
          JOIN j5_a2a_squadron AS squadron ON squadron.id = machine.squadron_id
          WHERE machine.participant_id = ${participantId}
          LIMIT 1
        `;
        return rows[0] === undefined ? null : recordFromRow(rows[0]);
      });

      const register: MachineParticipantServiceShape["register"] = (input) =>
        Effect.gen(function* () {
          if (!MACHINE_PARTICIPANT_NAME_PATTERN.test(input.name)) {
            return yield* new MachineParticipantInvalidNameError({ name: input.name });
          }
          const participantId = machineParticipantIdForName(input.name);
          yield* ledger.readSquadron(input.squadronId);
          const existing = yield* readRow(participantId);
          if (existing !== null && existing.squadronId !== input.squadronId) {
            return yield* new MachineParticipantNameTakenError({
              participantId,
              existingSquadronId: existing.squadronId,
              requestedSquadronId: input.squadronId,
            });
          }
          if (existing !== null) return { participant: existing, created: false };

          const appended = yield* ledger.append({
            commandId: input.commandId,
            squadronId: input.squadronId,
            acceptedAt: input.acceptedAt,
            event: {
              kind: "participant.joined",
              sender: null,
              receiver: participantId,
              exchangeId: null,
              correlationId: null,
              payload: { participant: { kind: "machine", id: participantId, name: input.name } },
              createdAt: input.acceptedAt,
            },
          });
          const registered = yield* readRow(participantId);
          if (registered === null) {
            return yield* new A2AStorageError({ operation: "project machine participant join" });
          }
          return { participant: registered, created: appended.committed };
        });

      const resolve: MachineParticipantServiceShape["resolve"] = (participantId) =>
        Effect.gen(function* () {
          const row = yield* readRow(participantId);
          if (row === null) return yield* new MachineParticipantNotFoundError({ participantId });
          return row;
        });

      const list: MachineParticipantServiceShape["list"] = () =>
        sql<MachineRow>`
          SELECT
            machine.participant_id,
            machine.squadron_id,
            squadron.name AS squadron_name,
            machine.name,
            machine.created_at
          FROM j5_a2a_machine_participant AS machine
          JOIN j5_a2a_squadron AS squadron ON squadron.id = machine.squadron_id
          ORDER BY machine.squadron_id, machine.participant_id
        `.pipe(Effect.map((rows) => rows.map(recordFromRow)));

      return MachineParticipantService.of({ register, resolve, list });
    }),
  );
