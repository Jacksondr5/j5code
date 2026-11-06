// @effect-diagnostics nodeBuiltinImport:off - a random id; no Crypto service is wired into this layer.
import * as NodeCrypto from "node:crypto";
import type {
  AgentPersonaBlockCode,
  AgentPersonaEscalationView,
  AgentPersonaPickConstraint,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { AgentCrewInstanceService } from "../a2a/AgentCrewInstanceService.ts";
import { ParticipantId } from "../a2a/contracts.ts";

/** The rule every persona launch tool states, in the same words. */
export const BLOCKED_PERSONA_TOOL_TEXT =
  "A refused persona stays blocked and its refusal gives a code and an escalation_id: never recreate it as a custom worker or plain agent to get around its limits. Escalate it instead, and retry with allow_once only after an Owner allows it once.";

/** The retry field on every persona launch tool. */
export const AllowOnceInput = Schema.String.check(Schema.isNonEmpty()).annotate({
  description:
    "Only to retry a persona launch the person allowed once: the escalation_id from its refusal. It lifts the one limit named there for this launch only; any later launch is held to the persona's limits again. A text reply never grants it.",
});

/** Why an escalation can't be asked about, granted, or used as asked. */
export class AgentPersonaEscalationError extends Schema.TaggedError<AgentPersonaEscalationError>()(
  "AgentPersonaEscalationError",
  { message: Schema.String },
) {}

const CONSTRAINT_TEXT: Record<AgentPersonaPickConstraint, string> = {
  "model-not-eligible": "a model Models for custom members doesn't check",
  "access-above-caller": "broader access than its caller runs with",
};

/**
 * The one text form of a refused persona launch, wherever an agent reads it. With no escalation
 * (an outside agent's launch), the caller tells the person itself.
 */
export const personaBlockText = (block: {
  readonly code: AgentPersonaBlockCode;
  readonly detail: string;
  readonly escalationId: string | null;
  readonly waivable: AgentPersonaPickConstraint | null;
}) =>
  [
    `[${block.code}] ${block.detail}`,
    "Never recreate a blocked persona as a custom worker to get around this.",
    block.escalationId === null
      ? "Tell the person directly."
      : [
          `escalation_id: ${block.escalationId}.`,
          block.waivable === null
            ? "No single exception lets it run, so the cause must be fixed."
            : `An Owner can allow it once past ${CONSTRAINT_TEXT[block.waivable]}.`,
          "A Crew member tells its Captain the escalation_id; anyone else asks the person with j5_send_message (expect_reply, escalation_id) in a fresh ask, after clearing or settling any ask already open with them.",
          block.waivable === null
            ? ""
            : "If they allow it once, retry the same launch with allow_once set to the escalation_id.",
        ]
          .filter((part) => part !== "")
          .join(" "),
  ].join(" ");

/** The fixed reply "Allow this once" answers an ask with. */
export const allowedOnceReply = (
  personaId: string,
  constraint: AgentPersonaPickConstraint,
  escalationId: string,
) =>
  `Allowed once: ${personaId} past ${CONSTRAINT_TEXT[constraint]}. Retry the launch with allow_once: ${escalationId}.`;

interface EscalationRow {
  readonly id: string;
  readonly caller_participant_id: string;
  readonly persona_id: string;
  readonly code: string;
  readonly summary: string;
  readonly waivable: AgentPersonaPickConstraint | null;
  readonly exchange_id: string | null;
  readonly status: "open" | "granted" | "used";
}

export interface AgentPersonaEscalationsShape {
  /** Record a refused launch; returns its id. */
  readonly record: (input: {
    readonly callerParticipantId: string;
    readonly personaId: string;
    readonly code: AgentPersonaBlockCode;
    readonly summary: string;
    readonly waivable: AgentPersonaPickConstraint | null;
  }) => Effect.Effect<string, SqlError>;
  /**
   * The trusted text an ask about this escalation carries. The asker is the caller it was
   * recorded for, or that caller's Captain; only an open escalation is asked about.
   */
  readonly askSummary: (input: {
    readonly escalationId: string;
    readonly askerParticipantId: string;
  }) => Effect.Effect<string, AgentPersonaEscalationError | SqlError>;
  /** Link the ask that carries the escalation, so the person's Inbox can offer the grant. */
  readonly linkAsk: (input: {
    readonly escalationId: string;
    readonly exchangeId: string;
  }) => Effect.Effect<void, SqlError>;
  /** The escalation each of these asks carries, keyed by exchange id. */
  readonly forExchanges: (
    exchangeIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, AgentPersonaEscalationView>, SqlError>;
  /** The ask's waivable escalation, open and ready for the Owner's "Allow this once". */
  readonly grantable: (exchangeId: string) => Effect.Effect<
    {
      readonly escalationId: string;
      readonly personaId: string;
      readonly constraint: AgentPersonaPickConstraint;
    },
    AgentPersonaEscalationError | SqlError
  >;
  readonly markGranted: (input: {
    readonly escalationId: string;
    readonly grantedBy: string;
  }) => Effect.Effect<void, AgentPersonaEscalationError | SqlError>;
  /** The limit a retry may waive: the grant must be unused and for this caller and persona. */
  readonly grantedWaiver: (input: {
    readonly escalationId: string;
    readonly callerParticipantId: string | undefined;
    readonly personaId: string;
  }) => Effect.Effect<AgentPersonaPickConstraint, AgentPersonaEscalationError | SqlError>;
  /** Spend a grant on the launch it allowed; a second launch is refused. */
  readonly use: (
    escalationId: string,
  ) => Effect.Effect<void, AgentPersonaEscalationError | SqlError>;
}

export class AgentPersonaEscalations extends Context.Service<
  AgentPersonaEscalations,
  AgentPersonaEscalationsShape
>()("t3/j5/agents/agentPersonaEscalation/AgentPersonaEscalations") {}

const refuse = (message: string) => new AgentPersonaEscalationError({ message });

export const layer = Layer.effect(
  AgentPersonaEscalations,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crews = yield* AgentCrewInstanceService;
    const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

    const read = Effect.fn("j5.agents.escalations.read")(function* (escalationId: string) {
      const rows = yield* sql<EscalationRow>`
        SELECT * FROM j5_persona_escalation WHERE id = ${escalationId}
      `;
      const row = rows[0];
      if (row === undefined)
        return yield* refuse(`There is no escalation ${escalationId} on this server.`);
      return row;
    });

    const record: AgentPersonaEscalationsShape["record"] = Effect.fn(
      "j5.agents.escalations.record",
    )(function* (input) {
      const id = `escalation-${NodeCrypto.randomUUID()}`;
      yield* sql`
        INSERT INTO j5_persona_escalation (
          id, caller_participant_id, persona_id, code, summary, waivable, status, created_at
        ) VALUES (
          ${id}, ${input.callerParticipantId}, ${input.personaId}, ${input.code},
          ${input.summary}, ${input.waivable}, 'open', ${yield* now}
        )
      `;
      return id;
    });

    const askSummary: AgentPersonaEscalationsShape["askSummary"] = Effect.fn(
      "j5.agents.escalations.askSummary",
    )(function* (input) {
      const row = yield* read(input.escalationId);
      if (row.caller_participant_id !== input.askerParticipantId) {
        const membership = yield* crews.findMembership(
          ParticipantId.make(row.caller_participant_id),
        );
        const crew = membership === null ? null : yield* crews.read(membership.crewInstanceId);
        if (crew?.captainParticipantId !== input.askerParticipantId)
          return yield* refuse(
            `Escalation ${input.escalationId} is another agent's. Ask about your own escalations, or, as a Captain, your Crew members'.`,
          );
      }
      if (row.status !== "open")
        return yield* refuse(
          `Escalation ${input.escalationId} is already ${row.status === "granted" ? "allowed once: retry the launch with allow_once" : "used"}.`,
        );
      return [
        `J5 recorded this blocked launch (escalation ${row.id}, ${row.code}): ${row.summary}`,
        row.waivable === null
          ? "No single exception lets it run; fixing the cause or replying in text are the options."
          : `An Owner can allow it once past ${CONSTRAINT_TEXT[row.waivable]}.`,
      ].join(" ");
    });

    const linkAsk: AgentPersonaEscalationsShape["linkAsk"] = (input) =>
      sql`
        UPDATE j5_persona_escalation SET exchange_id = ${input.exchangeId}
        WHERE id = ${input.escalationId}
      `.pipe(Effect.asVoid);

    const forExchanges: AgentPersonaEscalationsShape["forExchanges"] = Effect.fn(
      "j5.agents.escalations.forExchanges",
    )(function* (exchangeIds) {
      if (exchangeIds.length === 0) return new Map();
      const rows = yield* sql<EscalationRow>`
        SELECT * FROM j5_persona_escalation WHERE ${sql.in("exchange_id", exchangeIds)}
      `;
      return new Map(
        rows.map((row) => [
          row.exchange_id!,
          {
            escalationId: row.id,
            personaId: row.persona_id,
            waivable: row.waivable,
            status: row.status,
          },
        ]),
      );
    });

    const grantable: AgentPersonaEscalationsShape["grantable"] = Effect.fn(
      "j5.agents.escalations.grantable",
    )(function* (exchangeId) {
      const rows = yield* sql<EscalationRow>`
        SELECT * FROM j5_persona_escalation WHERE exchange_id = ${exchangeId}
      `;
      const row = rows[0];
      if (row === undefined) return yield* refuse("This ask doesn't escalate a blocked persona.");
      if (row.waivable === null)
        return yield* refuse(
          `No single exception lets ${row.persona_id} run, so it can't be allowed once.`,
        );
      if (row.status !== "open")
        return yield* refuse(`${row.persona_id} was already allowed once for this request.`);
      return { escalationId: row.id, personaId: row.persona_id, constraint: row.waivable };
    });

    const markGranted: AgentPersonaEscalationsShape["markGranted"] = Effect.fn(
      "j5.agents.escalations.markGranted",
    )(function* (input) {
      const updated = yield* sql<{ readonly id: string }>`
        UPDATE j5_persona_escalation
        SET status = 'granted', granted_by = ${input.grantedBy}, granted_at = ${yield* now}
        WHERE id = ${input.escalationId} AND status = 'open'
        RETURNING id
      `;
      if (updated.length === 0)
        return yield* refuse(`Escalation ${input.escalationId} was already allowed once.`);
    });

    const grantedWaiver: AgentPersonaEscalationsShape["grantedWaiver"] = Effect.fn(
      "j5.agents.escalations.grantedWaiver",
    )(function* (input) {
      const row = yield* read(input.escalationId);
      if (row.caller_participant_id !== input.callerParticipantId)
        return yield* refuse(
          `allow_once ${input.escalationId} was granted to another caller; only the agent whose launch was refused can retry with it.`,
        );
      if (row.persona_id !== input.personaId)
        return yield* refuse(
          `allow_once ${input.escalationId} is for persona ${row.persona_id}, not ${input.personaId}.`,
        );
      if (row.status === "used")
        return yield* refuse(
          `allow_once ${input.escalationId} was already used; each allowance covers one launch.`,
        );
      if (row.status !== "granted" || row.waivable === null)
        return yield* refuse(
          `allow_once ${input.escalationId} has not been allowed: only an Owner's "Allow this once" on the ask grants it, never a text reply.`,
        );
      return row.waivable;
    });

    const use: AgentPersonaEscalationsShape["use"] = Effect.fn("j5.agents.escalations.use")(
      function* (escalationId) {
        const updated = yield* sql<{ readonly id: string }>`
          UPDATE j5_persona_escalation SET status = 'used', used_at = ${yield* now}
          WHERE id = ${escalationId} AND status = 'granted'
          RETURNING id
        `;
        if (updated.length === 0)
          return yield* refuse(
            `allow_once ${escalationId} was already used; each allowance covers one launch.`,
          );
      },
    );

    return AgentPersonaEscalations.of({
      record,
      askSummary,
      linkAsk,
      forExchanges,
      grantable,
      markGranted,
      grantedWaiver,
      use,
    });
  }),
);
