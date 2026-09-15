import type { A2ARosterEntry, A2ARosterLiveness } from "@t3tools/contracts/j5";
import { type OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { listRegisteredHumanPersonIds } from "./HumanPersonRegistry.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { ParticipantId } from "./contracts.ts";

/**
 * The read-only roster a machine sender preflights against: every participant
 * with its measured liveness, plus the recipient resolution `j5 a2a send --to`
 * relies on. Liveness is read from the thread shell snapshot, never asked of
 * an agent.
 */

export type RecipientResolution =
  | { readonly kind: "resolved"; readonly participantId: ParticipantId }
  | { readonly kind: "ambiguous"; readonly candidates: ReadonlyArray<A2ARosterEntry> }
  | { readonly kind: "not_found" };

export interface RosterServiceShape {
  readonly list: () => Effect.Effect<ReadonlyArray<A2ARosterEntry>, SqlError>;
  /** `to` is a participant id, a thread id, or an unarchived agent's exact display name. */
  readonly resolveRecipient: (to: string) => Effect.Effect<RecipientResolution, SqlError>;
}

export class RosterService extends Context.Service<RosterService, RosterServiceShape>()(
  "t3/j5/a2a/RosterService",
) {}

interface AgentRow {
  readonly squadron_id: string;
  readonly squadron_name: string;
  readonly participant_id: string;
  readonly thread_id: string;
  readonly archived_at: string | null;
}

interface MachineRow {
  readonly squadron_id: string;
  readonly squadron_name: string;
  readonly participant_id: string;
  readonly name: string;
}

const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

const formatInstant = (value: DateTime.Utc | null | undefined) =>
  value == null ? null : DateTime.formatIso(value);

export const livenessForShellThread = (thread: OrchestrationV2ThreadShell): A2ARosterLiveness => ({
  state:
    thread.activeRunId !== null || ACTIVE_STATUSES.has(thread.status)
      ? "active"
      : thread.status === "failed"
        ? "errored"
        : "idle",
  runStatus: thread.status,
  latestRunStartedAt: formatInstant(thread.latestRunStartedAt),
  latestRunCompletedAt: formatInstant(thread.latestRunCompletedAt),
  lastError: thread.lastError ?? null,
});

const PARTICIPANT_ID_PREFIXES = ["agent:", "human:", "machine:", "platform:"];

export const layer: Layer.Layer<RosterService, never, SqlClient.SqlClient | OrchestratorV2> =
  Layer.effect(
    RosterService,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const orchestrator = yield* OrchestratorV2;

      const list: RosterServiceShape["list"] = () =>
        Effect.gen(function* () {
          const agents = yield* sql<AgentRow>`
            SELECT
              membership.squadron_id,
              squadron.name AS squadron_name,
              membership.participant_id,
              membership.thread_id,
              membership.archived_at
            FROM j5_a2a_squadron_membership AS membership
            JOIN j5_a2a_squadron AS squadron ON squadron.id = membership.squadron_id
            ORDER BY membership.squadron_id, membership.participant_id
          `;
          const machines = yield* sql<MachineRow>`
            SELECT
              machine.squadron_id,
              squadron.name AS squadron_name,
              machine.participant_id,
              machine.name
            FROM j5_a2a_machine_participant AS machine
            JOIN j5_a2a_squadron AS squadron ON squadron.id = machine.squadron_id
            ORDER BY machine.squadron_id, machine.participant_id
          `;
          const people = yield* listRegisteredHumanPersonIds(sql);
          const snapshot = yield* Effect.option(orchestrator.getShellSnapshot());
          const shellByThreadId = new Map(
            Option.match(snapshot, {
              onNone: () => [],
              onSome: ({ archivedThreads, threads }) =>
                [...threads, ...archivedThreads].map((thread) => [thread.id, thread] as const),
            }),
          );
          const membershipCounts = new Map<string, number>();
          for (const row of agents) {
            membershipCounts.set(
              row.participant_id,
              (membershipCounts.get(row.participant_id) ?? 0) + 1,
            );
          }
          return [
            ...agents.map((row): A2ARosterEntry => {
              const shell = shellByThreadId.get(ThreadId.make(row.thread_id));
              return {
                participantId: row.participant_id,
                kind: "agent",
                squadronId: row.squadron_id,
                squadronName: row.squadron_name,
                displayName: shell?.title ?? null,
                threadId: ThreadId.make(row.thread_id),
                archived: row.archived_at !== null,
                canReceiveMessage:
                  row.archived_at === null && membershipCounts.get(row.participant_id) === 1,
                acceptsUrgency: false,
                liveness: shell === undefined ? null : livenessForShellThread(shell),
              };
            }),
            ...people.map((personId): A2ARosterEntry => ({
              participantId: personId,
              kind: "human",
              squadronId: null,
              squadronName: null,
              displayName: null,
              threadId: null,
              archived: false,
              canReceiveMessage: false,
              acceptsUrgency: true,
              liveness: null,
            })),
            ...machines.map((row): A2ARosterEntry => ({
              participantId: row.participant_id,
              kind: "machine",
              squadronId: row.squadron_id,
              squadronName: row.squadron_name,
              displayName: row.name,
              threadId: null,
              archived: false,
              canReceiveMessage: false,
              acceptsUrgency: false,
              liveness: null,
            })),
          ];
        });

      const resolveRecipient: RosterServiceShape["resolveRecipient"] = (to) =>
        Effect.gen(function* () {
          const target = to.trim();
          if (PARTICIPANT_ID_PREFIXES.some((prefix) => target.startsWith(prefix))) {
            return { kind: "resolved", participantId: ParticipantId.make(target) } as const;
          }
          const entries = yield* list();
          const byThread = entries.find((entry) => entry.threadId === target);
          if (byThread !== undefined) {
            return {
              kind: "resolved",
              participantId: participantIdForThread(ThreadId.make(target)),
            } as const;
          }
          const wanted = target.toLowerCase();
          const byName = entries.filter(
            (entry) =>
              entry.kind === "agent" &&
              !entry.archived &&
              entry.displayName !== null &&
              entry.displayName.trim().toLowerCase() === wanted,
          );
          if (byName.length === 1) {
            return {
              kind: "resolved",
              participantId: ParticipantId.make(byName[0]!.participantId),
            } as const;
          }
          if (byName.length > 1) return { kind: "ambiguous", candidates: byName } as const;
          return { kind: "not_found" } as const;
        });

      return RosterService.of({ list, resolveRecipient });
    }),
  );
