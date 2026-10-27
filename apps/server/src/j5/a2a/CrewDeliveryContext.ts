import { CommandId, ThreadId, type OrchestrationV2ServerCommand } from "@t3tools/contracts";
import { CrewSeatWorkspace, crewDeliveryContextPrefix } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as KeyedLock from "@t3tools/shared/KeyedLock";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { CommandReceiptStoreV2 } from "../../orchestration-v2/CommandReceiptStore.ts";
import * as Crews from "./AgentCrewInstanceService.ts";
import * as ReadChanges from "./ReadChanges.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { crewContextText } from "./spawnIds.ts";

class CrewSeatWorkspaceNotReadyError extends Orchestrator.OrchestratorDispatchError.extend<CrewSeatWorkspaceNotReadyError>(
  "CrewSeatWorkspaceNotReadyError",
)({ threadId: ThreadId }) {
  override get message(): string {
    return "This Crew seat's worktree is not ready. Retry workspace preparation in its thread before sending more work.";
  }
}
const isWorkspaceNotReady = Schema.is(CrewSeatWorkspaceNotReadyError);

const Roster = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      seat: Schema.String,
      participantId: Schema.String,
      agentDisplayName: Schema.String,
      reason: Schema.NullOr(Schema.String),
    }),
  ),
);
const encodeRoster = Schema.encodeSync(Roster);
const isOrchestratorError = Schema.is(Orchestrator.OrchestratorV2Error);
const decodeRoster = Schema.decodeUnknownEffect(Roster);
const decodeWorkspace = Schema.decodeUnknownEffect(Schema.fromJsonString(CrewSeatWorkspace));
const line = (value: string) => value.replace(/\s+/g, " ").replace(/<\//g, "<\\/").trim();

interface SeatContextRow {
  readonly first_turn_text: string;
  readonly workspace: string;
  readonly delivered_roster: string | null;
  readonly pending_command_id: string | null;
  readonly pending_roster: string | null;
  readonly pending_message_id: string | null;
  readonly pending_prefix: string | null;
}

/** All message entry points meet here, before upstream commits the assignment and starts work. */
export const layer = Layer.effect(
  Orchestrator.OrchestratorV2,
  Effect.gen(function* () {
    const inner = yield* Orchestrator.OrchestratorV2;
    const sql = yield* SqlClient.SqlClient;
    const crews = yield* Crews.AgentCrewInstanceService;
    const receipts = yield* CommandReceiptStoreV2;
    const changes = yield* ReadChanges.ReadChanges;
    const locks = yield* KeyedLock.make<string>();

    const acknowledge = (
      threadId: string,
      roster: string | null,
      messageId: string | null,
      prefix: string,
    ) =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (prefix !== "" && messageId !== null)
            yield* sql`
        UPDATE j5_a2a_message_author SET stored_prefix = ${prefix} || stored_prefix
        WHERE thread_id = ${threadId} AND message_id = ${messageId}
      `;
          yield* sql`
        UPDATE j5_crew_seat_context SET delivered_roster = ${roster},
          pending_command_id = NULL, pending_roster = NULL, pending_message_id = NULL,
          pending_prefix = NULL WHERE thread_id = ${threadId}
      `;
        }),
      );

    const dispatch: Orchestrator.OrchestratorV2["Service"]["dispatch"] = (command) => {
      if (command.type !== "message.dispatch") return inner.dispatch(command);
      return locks.withLock(
        command.threadId,
        Effect.gen(function* () {
          const rows = yield* sql<SeatContextRow>`
        SELECT * FROM j5_crew_seat_context WHERE thread_id = ${command.threadId}
      `;
          const context = rows[0];
          if (context === undefined) return yield* inner.dispatch(command);
          // A dispatch may have committed before the process stopped, leaving only this bookkeeping owed.
          let deliveredRoster = context.delivered_roster;
          if (context.pending_command_id !== null) {
            const receipt = yield* receipts.getByCommandId(
              CommandId.make(context.pending_command_id),
            );
            if (Option.isSome(receipt) && receipt.value.status === "accepted") {
              deliveredRoster = context.pending_roster;
              yield* acknowledge(
                command.threadId,
                deliveredRoster,
                context.pending_message_id,
                context.pending_prefix ?? "",
              );
              if (context.delivered_roster === null) yield* changes.notify("crew", "fleet");
            }
          }
          const replay = yield* receipts.getByCommandId(command.commandId);
          if (Option.isSome(replay)) return yield* inner.dispatch(command);
          const membership = yield* crews.findMembership(participantIdForThread(command.threadId));
          if (membership === null) return yield* inner.dispatch(command);
          const crew = yield* crews.read(membership.crewInstanceId);
          if (crew === null) return yield* inner.dispatch(command);
          const roster = crew.members.map((member) => ({
            seat: member.seatName,
            participantId: member.participantId,
            agentDisplayName: member.agentId ?? "custom",
            reason: member.reason,
          }));
          const rosterJson = encodeRoster(roster);
          let prefix = "";
          if (deliveredRoster === null) {
            prefix = context.first_turn_text.replace(
              /<j5_crew_context>[\s\S]*?<\/j5_crew_context>/,
              () =>
                crewContextText({
                  displayName: crew.displayName,
                  instanceId: crew.id,
                  seatName: membership.seatName,
                  captainParticipantId: crew.captainParticipantId,
                  roster,
                }),
            );
          } else {
            const previous = yield* decodeRoster(deliveredRoster);
            const joined = roster.filter(
              (member) => !previous.some((old) => old.participantId === member.participantId),
            );
            const left = previous.filter(
              (member) => !roster.some((current) => current.participantId === member.participantId),
            );
            const describe = (member: (typeof Roster.Type)[number]) =>
              `${line(member.seat)}: participant_id=${member.participantId} responsibility=${line(member.reason ?? "")}`;
            if (joined.length > 0 || left.length > 0)
              prefix = [
                "<j5_crew_roster_changed>",
                ...joined.map((member) => `joined: ${describe(member)}`),
                ...left.map((member) => `left: ${describe(member)}`),
                "</j5_crew_roster_changed>",
              ].join("\n");
          }
          const workspace = yield* decodeWorkspace(context.workspace);
          if (deliveredRoster !== null && workspace.type === "worktree") {
            const shell = yield* inner.getThreadShell(command.threadId);
            if (shell !== null && shell.worktreePath === null) {
              const projection = yield* inner.getThreadRecords(command.threadId, ["runs"]);
              if (!projection.runs.some((run) => run.status === "preparing")) {
                return yield* new CrewSeatWorkspaceNotReadyError({
                  threadId: command.threadId,
                  commandId: command.commandId,
                  commandType: command.type,
                });
              }
            }
          }
          if (deliveredRoster === rosterJson) return yield* inner.dispatch(command);
          prefix = crewDeliveryContextPrefix(prefix);
          const prepared: OrchestrationV2ServerCommand = {
            ...command,
            text: prefix === "" ? command.text : `${prefix}${command.text}`,
            ...(deliveredRoster === null && workspace.type === "worktree"
              ? { dispatchMode: { type: "defer_start" as const, workspaceStrategy: workspace } }
              : {}),
          };
          yield* sql`
        UPDATE j5_crew_seat_context SET pending_command_id = ${command.commandId},
          pending_roster = ${rosterJson}, pending_message_id = ${command.messageId},
          pending_prefix = ${prefix} WHERE thread_id = ${command.threadId}
      `;
          // Acceptance owns this context even if provider startup fails; retries keep the stored message.
          const result = yield* inner.dispatch(prepared);
          yield* acknowledge(command.threadId, rosterJson, command.messageId, prefix);
          if (deliveredRoster === null) yield* changes.notify("crew", "fleet");
          return result;
        }).pipe(
          Effect.mapError((cause) =>
            isOrchestratorError(cause) || isWorkspaceNotReady(cause)
              ? cause
              : new Orchestrator.OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause,
                }),
          ),
        ),
      );
    };
    return Orchestrator.OrchestratorV2.of({ ...inner, dispatch });
  }),
).pipe(Layer.provide(Crews.layer), Layer.provide(ReadChanges.layer));
