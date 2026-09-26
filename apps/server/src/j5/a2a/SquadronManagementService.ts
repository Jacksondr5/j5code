import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import * as ProjectService from "../../project/ProjectService.ts";
import { ThreadLifecycleService } from "../../orchestration-v2/ThreadLifecycleService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { randomUuidV4 } from "../../orchestration-v2/RandomUuid.ts";
import { AgentCrewInstanceService } from "./AgentCrewInstanceService.ts";
import { ArchiveAgentService } from "./ArchiveAgentService.ts";
import { ArchiveCrewService } from "./ArchiveCrewService.ts";
import { A2ALedger, type A2ALedgerError } from "./LedgerService.ts";
import {
  SquadronProjectReferences,
  type SquadronProjectReferenceError,
} from "./SquadronProjectReferences.ts";
import { ParticipantId, SquadronId, type Squadron } from "./contracts.ts";
import { crewSeatRequestKey, lifecycleCommandId } from "./spawnIds.ts";
import { getThreadProjectionIfPresent } from "./threadProjectionReads.ts";

export interface ManagedSquadron {
  readonly squadron: Squadron;
  readonly projectIds: ReadonlyArray<ProjectId>;
}

export interface CreateSquadronInput {
  readonly name: string;
  readonly projectId: ProjectId;
}

export interface RenameSquadronInput {
  readonly squadronId: SquadronId;
  readonly name: string;
}

export class SquadronNameRequiredError extends Schema.TaggedError<SquadronNameRequiredError>()(
  "SquadronNameRequiredError",
  {},
) {
  override get message(): string {
    return "A Squadron name is required.";
  }
}

export class SquadronProjectNotFoundError extends Schema.TaggedError<SquadronProjectNotFoundError>()(
  "SquadronProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project ${this.projectId} must already exist before it can be attached to a Squadron.`;
  }
}

/**
 * Only live state keeps a Squadron alive: unarchived agent members and
 * unarchived Crews. Stopping pauses work but keeps both, so archive is the
 * gate. History never blocks, and a send-only machine credential is not
 * running work, so both are purged with the Squadron.
 */
export const SquadronDeleteBlockerKind = Schema.Literals(["agents", "crews"]);
export type SquadronDeleteBlockerKind = typeof SquadronDeleteBlockerKind.Type;

const blockerLabel = (kind: SquadronDeleteBlockerKind, count: number): string => {
  const plural = count === 1 ? "" : "s";
  switch (kind) {
    case "agents":
      return `${count} active agent${plural}`;
    case "crews":
      return `${count} unarchived Crew${plural}`;
  }
};

/**
 * The foreign keys onto `j5_a2a_squadron` that are ON DELETE RESTRICT, in
 * delete order. Every other referencing table (and its children) cascades
 * from the Squadron row under the `foreign_keys` pragma the server always
 * enables.
 */
export const SQUADRON_RESTRICT_TABLES = [
  "j5_a2a_placement_event",
  "j5_a2a_comm_command_receipt",
  "j5_a2a_comm_event",
] as const;

const SQUADRON_DELETE_SESSION = "j5-squadron-delete-human";

const joinBlockers = (labels: ReadonlyArray<string>): string =>
  labels.length <= 1
    ? (labels[0] ?? "")
    : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;

export class SquadronDeleteBlockedError extends Schema.TaggedError<SquadronDeleteBlockedError>()(
  "SquadronDeleteBlockedError",
  {
    squadronId: SquadronId,
    name: Schema.String,
    blockers: Schema.Array(
      Schema.Struct({ kind: SquadronDeleteBlockerKind, count: Schema.Number }),
    ),
  },
) {
  override get message(): string {
    const labels = this.blockers.map((blocker) => blockerLabel(blocker.kind, blocker.count));
    return `Squadron "${this.name}" cannot be deleted while it still has ${joinBlockers(labels)}.`;
  }
}

/** A forced delete stopped while archiving or deleting threads; what committed stays, a retry finishes. */
export class SquadronDeleteIncompleteError extends Schema.TaggedError<SquadronDeleteIncompleteError>()(
  "SquadronDeleteIncompleteError",
  { squadronId: SquadronId, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Deleting the Squadron stopped partway. Try again to finish.";
  }
}

export type SquadronManagementError =
  | A2ALedgerError
  | ProjectService.ProjectServiceError
  | SquadronProjectReferenceError
  | SquadronNameRequiredError
  | SquadronProjectNotFoundError
  | SquadronDeleteBlockedError
  | SquadronDeleteIncompleteError;

export interface SquadronManagementServiceShape {
  readonly list: () => Effect.Effect<ReadonlyArray<ManagedSquadron>, SquadronManagementError>;
  readonly create: (
    input: CreateSquadronInput,
  ) => Effect.Effect<ManagedSquadron, SquadronManagementError>;
  readonly rename: (
    input: RenameSquadronInput,
  ) => Effect.Effect<ManagedSquadron, SquadronManagementError>;
  /**
   * Refuses while live agents or Crews remain. With `force`, deletes every thread that ever joined
   * the Squadron first, the way upstream's forced project delete removes the project's threads.
   */
  readonly delete: (
    squadronId: SquadronId,
    options?: { readonly force?: boolean },
  ) => Effect.Effect<void, SquadronManagementError>;
}

/**
 * The creation surface owns the explicit name-plus-project command. Project
 * references are resources, never an alternate way to resolve a Squadron.
 */
export class SquadronManagementService extends Context.Service<
  SquadronManagementService,
  SquadronManagementServiceShape
>()("t3/j5/a2a/SquadronManagementService") {}

export const layer: Layer.Layer<
  SquadronManagementService,
  never,
  | A2ALedger
  | AgentCrewInstanceService
  | ArchiveAgentService
  | ArchiveCrewService
  | ProjectService.ProjectService
  | SquadronProjectReferences
  | SqlClient.SqlClient
  | ThreadLifecycleService
  | ThreadManagementService
> = Layer.effect(
  SquadronManagementService,
  Effect.gen(function* () {
    const ledger = yield* A2ALedger;
    const projects = yield* ProjectService.ProjectService;
    const references = yield* SquadronProjectReferences;
    const sql = yield* SqlClient.SqlClient;
    const crewInstances = yield* AgentCrewInstanceService;
    const archiveAgents = yield* ArchiveAgentService;
    const archiveCrews = yield* ArchiveCrewService;
    const threadLifecycle = yield* ThreadLifecycleService;
    const threadManagement = yield* ThreadManagementService;

    const list = Effect.fn("j5.a2a.squadronManagement.list")(function* () {
      const squadrons = yield* ledger.listSquadrons();
      return yield* Effect.forEach(
        squadrons,
        (squadron) =>
          references.listForSquadron(squadron.id).pipe(
            Effect.map((projectReferences) => ({
              squadron,
              projectIds: projectReferences.map((ref) => ref.projectId),
            })),
          ),
        { concurrency: 1 },
      );
    });

    const create = Effect.fn("j5.a2a.squadronManagement.create")(function* (
      input: CreateSquadronInput,
    ) {
      const name = input.name.trim();
      if (name.length === 0) return yield* new SquadronNameRequiredError();

      const project = yield* projects.getById(input.projectId);
      if (Option.isNone(project)) {
        return yield* new SquadronProjectNotFoundError({ projectId: input.projectId });
      }

      const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const squadron = {
        id: SquadronId.make(`squadron:${yield* randomUuidV4}`),
        name,
        createdAt,
      } as const;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const created = yield* ledger.createSquadron({ squadron });
          const projectReferences = yield* references.replaceForSquadron({
            squadronId: created.id,
            projectIds: [input.projectId],
            createdAt,
          });
          return { squadron: created, projectIds: projectReferences.map((ref) => ref.projectId) };
        }),
      );
    });

    const rename = Effect.fn("j5.a2a.squadronManagement.rename")(function* (
      input: RenameSquadronInput,
    ) {
      const name = input.name.trim();
      if (name.length === 0) return yield* new SquadronNameRequiredError();
      const squadron = yield* ledger.renameSquadron({ squadronId: input.squadronId, name });
      const projectReferences = yield* references.listForSquadron(squadron.id);
      return { squadron, projectIds: projectReferences.map((ref) => ref.projectId) };
    });

    const countBlockers = (squadronId: SquadronId) => {
      const count = (query: Effect.Effect<ReadonlyArray<{ readonly count: number }>, SqlError>) =>
        query.pipe(Effect.map((rows) => Number(rows[0]?.count ?? 0)));
      return {
        agents: count(
          sql`SELECT COUNT(*) AS count FROM j5_a2a_squadron_membership WHERE squadron_id = ${squadronId} AND archived_at IS NULL`,
        ),
        crews: count(
          sql`SELECT COUNT(*) AS count FROM j5_agent_crew_instance WHERE squadron_id = ${squadronId} AND archived_at IS NULL`,
        ),
      } satisfies Record<SquadronDeleteBlockerKind, unknown>;
    };

    const purgeRestrictedRows = (squadronId: SquadronId) =>
      Effect.forEach(
        SQUADRON_RESTRICT_TABLES,
        (table) => sql.unsafe(`DELETE FROM ${table} WHERE squadron_id = ?`, [squadronId]),
        { discard: true },
      );

    // The last participant.joined in the ledger; a forced delete works on the agents that joined up
    // to here, and the final transaction refuses if anyone joined after it.
    const lastJoinSeq = (squadronId: SquadronId) =>
      sql<{ readonly seq: number | null }>`
        SELECT MAX(seq) AS seq FROM j5_a2a_comm_event
        WHERE squadron_id = ${squadronId} AND kind = 'participant.joined'
      `.pipe(Effect.map((rows) => Number(rows[0]?.seq ?? 0)));

    // The person confirmed the delete dialog, so both archives run with confirmation satisfied.
    // Archiving first closes Exchanges (including ones other Squadrons own) while this Squadron
    // still resolves as their home; the thread.deleted reactors alone could lose that race with
    // the purge. Crews go first so their seats retire as units; then every agent member goes
    // through the agent archive, archived ones included: membership is marked archived before its
    // Exchanges close, so a half-finished archive reads as archived, and the service completes it.
    // Then every thread whose agent joined here, live, archived, or retired, is deleted: the
    // Squadron is their only home. Ids are scoped to this attempt, since a rejected command id
    // stays rejected; a retry skips threads already deleted.
    const clearMembers = Effect.fn("j5.a2a.squadronManagement.clearMembers")(function* (
      squadronId: SquadronId,
      joinedThrough: number,
    ) {
      const requestKey = yield* randomUuidV4;
      const archivedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const commandId = (key: string, operation: string) =>
        lifecycleCommandId({
          providerSessionId: SQUADRON_DELETE_SESSION,
          requestKey: key,
          operation,
        });
      const archiveCommandIds = (key: string) => ({
        interruptCommandId: commandId(key, "delete-squadron-interrupt"),
        archiveCommandId: commandId(key, "delete-squadron-archive"),
      });
      const crews = yield* crewInstances.listForSquadron(squadronId);
      for (const crew of crews) {
        if (crew.archivedAt !== null) continue;
        yield* archiveCrews.archive({
          providerSessionId: SQUADRON_DELETE_SESSION,
          callerParticipantId: null,
          squadronId,
          crewInstanceId: crew.id,
          clientRequestKey: `${requestKey}:${crew.id}`,
          confirmationSatisfied: true,
          archivedAt,
          commandIds: (seatName) =>
            archiveCommandIds(crewSeatRequestKey(`${requestKey}:${crew.id}`, seatName)),
        });
      }
      const agents = yield* sql<{ readonly participant_id: string; readonly thread_id: string }>`
        SELECT participant_id, thread_id FROM j5_a2a_squadron_membership
        WHERE squadron_id = ${squadronId} AND thread_id IS NOT NULL
          AND joined_seq <= ${joinedThrough}
        ORDER BY joined_seq
      `;
      for (const agent of agents) {
        const participantId = ParticipantId.make(agent.participant_id);
        yield* archiveAgents.archive({
          providerSessionId: SQUADRON_DELETE_SESSION,
          // No participant asks for this archive; the token payload needs one, so it names itself.
          callerParticipantId: participantId,
          target: { squadronId, participantId, threadId: ThreadId.make(agent.thread_id) },
          clientRequestKey: `${requestKey}:${participantId}`,
          confirmationSatisfied: true,
          archivedAt,
          ...archiveCommandIds(`${requestKey}:${participantId}`),
        });
      }
      const threads = yield* sql<{ readonly thread_id: string }>`
        SELECT DISTINCT json_extract(payload, '$.participant.threadId') AS thread_id
        FROM j5_a2a_comm_event
        WHERE squadron_id = ${squadronId} AND kind = 'participant.joined' AND seq <= ${joinedThrough}
          AND json_extract(payload, '$.participant.kind') = 'agent'
      `;
      for (const row of threads) {
        const threadId = ThreadId.make(row.thread_id);
        const projection = yield* getThreadProjectionIfPresent(threadManagement, threadId);
        if (projection === null || projection.thread.deletedAt !== null) continue;
        yield* threadLifecycle.delete({
          commandId: commandId(`${requestKey}:${threadId}`, "delete-squadron-thread"),
          threadId,
        });
      }
    });

    // Hard delete in one transaction. Live agents or unarchived Crews refuse
    // with a named blocker; otherwise history and derived rows are purged and
    // threads that were homed here read as unknown-home afterwards. A forced
    // delete clears the members first; that runs orchestration commands, so
    // it sits outside the transaction, and an agent that joins meanwhile
    // refuses the delete so a retry clears it too.
    const remove = Effect.fn("j5.a2a.squadronManagement.delete")(function* (
      squadronId: SquadronId,
      options?: { readonly force?: boolean },
    ) {
      const force = options?.force === true;
      let joinedThrough = 0;
      if (force) {
        yield* ledger.readSquadron(squadronId);
        joinedThrough = yield* lastJoinSeq(squadronId);
        yield* clearMembers(squadronId, joinedThrough).pipe(
          Effect.mapError((cause) => new SquadronDeleteIncompleteError({ squadronId, cause })),
        );
      }
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const squadron = yield* ledger.readSquadron(squadronId);
          const counts = countBlockers(squadronId);
          const blockers: Array<{ kind: SquadronDeleteBlockerKind; count: number }> = [];
          for (const kind of SquadronDeleteBlockerKind.literals) {
            const count = yield* counts[kind];
            if (count > 0) blockers.push({ kind, count });
          }
          if (force && blockers.length === 0) {
            const joinedSince = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM j5_a2a_comm_event
              WHERE squadron_id = ${squadronId} AND kind = 'participant.joined'
                AND seq > ${joinedThrough}
            `;
            const count = Number(joinedSince[0]?.count ?? 0);
            if (count > 0) blockers.push({ kind: "agents", count });
          }
          if (blockers.length > 0) {
            return yield* new SquadronDeleteBlockedError({
              squadronId,
              name: squadron.name,
              blockers,
            });
          }
          yield* purgeRestrictedRows(squadronId);
          yield* ledger.deleteSquadron(squadronId);
        }),
      );
    });

    return SquadronManagementService.of({ list, create, rename, delete: remove });
  }),
);
