import { ThreadId } from "@t3tools/contracts";
import { crewDeliveryAssignment, crewDeliveryContextPrefix } from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Crews from "./AgentCrewInstanceService.ts";
import * as ReadChanges from "./ReadChanges.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { crewContextText } from "./spawnIds.ts";

class CrewTurnContextError extends Schema.TaggedError<CrewTurnContextError>()(
  "CrewTurnContextError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return "Cannot deliver this Crew seat's context. Restore its Crew before starting a waiting member.";
  }
}

const isCrewTurnContextError = Schema.is(CrewTurnContextError);

export class CrewTurnContext extends Context.Service<
  CrewTurnContext,
  {
    readonly deliver: <A, E, R>(
      threadId: ThreadId,
      text: string,
      send: (text: string) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | CrewTurnContextError, R>;
  }
>()("t3/j5/a2a/CrewTurnContext") {}

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
const decodeRoster = Schema.decodeUnknownEffect(Roster);
const line = (value: string) => value.replace(/\s+/g, " ").replace(/<\//g, "<\\/").trim();

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crews = yield* Crews.AgentCrewInstanceService;
  const changes = yield* ReadChanges.ReadChanges;
  const prepare = Effect.fn("j5.crewTurnContext.prepare")(function* (threadId: ThreadId) {
    return yield* Effect.gen(function* () {
      const [context] = yield* sql<{
        readonly first_turn_text: string;
        readonly delivered_roster: string | null;
      }>`
        SELECT first_turn_text, delivered_roster FROM j5_crew_seat_context WHERE thread_id = ${threadId}
      `;
      if (context === undefined) return null;
      const membership = yield* crews.findMembership(participantIdForThread(threadId));
      if (membership === null) {
        if (context.delivered_roster === null) return yield* new CrewTurnContextError({ threadId });
        return null;
      }
      const crew = yield* crews.read(membership.crewInstanceId);
      if (crew === null) return yield* new CrewTurnContextError({ threadId });
      const roster = crew.members.map((member) => ({
        seat: member.seatName,
        participantId: member.participantId,
        agentDisplayName: member.agentId ?? "custom",
        reason: member.reason,
      }));
      const rosterJson = encodeRoster(roster);
      let prefix = "";
      if (context.delivered_roster === null) {
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
        const previous = yield* decodeRoster(context.delivered_roster);
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

      return {
        prefix: crewDeliveryContextPrefix(prefix),
        delivered: sql`
          UPDATE j5_crew_seat_context SET delivered_roster = ${rosterJson},
            pending_command_id = NULL, pending_roster = NULL, pending_message_id = NULL, pending_prefix = NULL
          WHERE thread_id = ${threadId}
        `.pipe(
          Effect.andThen(changes.notify("crew", "fleet")),
          Effect.asVoid,
          Effect.mapError((cause) => new CrewTurnContextError({ threadId, cause })),
        ),
      };
    }).pipe(
      Effect.mapError((cause) =>
        isCrewTurnContextError(cause) ? cause : new CrewTurnContextError({ threadId, cause }),
      ),
    );
  });
  const deliver = <A, E, R>(
    threadId: ThreadId,
    text: string,
    send: (text: string) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const context = yield* prepare(threadId);
      if (context === null) return yield* send(text);
      const result = yield* send(`${context.prefix}${crewDeliveryAssignment(text)}`);
      // The provider accepted the prompt; bookkeeping failure must not fail its running turn.
      yield* context.delivered.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to record delivered Crew context", { threadId, cause }),
        ),
      );
      return result;
    });
  return CrewTurnContext.of({ deliver });
});

export const layer = Layer.effect(CrewTurnContext, make).pipe(
  Layer.provide(Crews.layer),
  Layer.provide(ReadChanges.layer),
);
