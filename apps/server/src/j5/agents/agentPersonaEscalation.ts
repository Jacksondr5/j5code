// @effect-diagnostics nodeBuiltinImport:off - a random id; no Crypto service is wired into this layer.
import * as NodeCrypto from "node:crypto";
import {
  RuntimeMode,
  type AgentPersonaBlockCode,
  type AgentPersonaEscalationView,
  type AgentPersonaPickConstraint,
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

/**
 * What a refusal showed the person, which bounds the one launch a grant allows: the definition
 * it was refused under, and each candidate the waiver lets run, with the access it would get.
 */
export const AgentPersonaWaiverScope = Schema.Struct({
  definitionDigest: Schema.String,
  entries: Schema.Array(
    Schema.Struct({
      entryIndex: Schema.Number,
      instanceId: Schema.String,
      model: Schema.String,
      runtimeMode: RuntimeMode,
      sandbox: Schema.optional(Schema.Literals(["readOnly", "workspaceWrite"])),
    }),
  ),
});
export type AgentPersonaWaiverScope = typeof AgentPersonaWaiverScope.Type;
const decodeScope = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentPersonaWaiverScope));
const encodeScope = Schema.encodeEffect(Schema.fromJsonString(AgentPersonaWaiverScope));

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
            : `An Owner can allow it once past ${CONSTRAINT_TEXT[block.waivable]}, with a button on your ask; a typed reply never allows it, so don't ask for one.`,
          "A Crew member tells its Captain the escalation_id; anyone else asks the person with j5_send_message (expect_reply, escalation_id) in a fresh ask, after clearing or settling any ask already open with them.",
          block.waivable === null
            ? ""
            : "If they allow it once, retry the same launch with allow_once set to the escalation_id.",
        ]
          .filter((part) => part !== "")
          .join(" "),
  ].join(" ");

/** The fixed reply "Allow this once" answers an ask with. */
export const allowedOnceReply = (grant: {
  readonly personaId: string;
  readonly constraint: AgentPersonaPickConstraint;
  readonly escalationId: string;
  readonly callerParticipantId: string;
}) =>
  `Allowed once: ${grant.personaId} past ${CONSTRAINT_TEXT[grant.constraint]}. Only ${grant.callerParticipantId}, whose launch was refused, can use it: it retries that launch with allow_once: ${grant.escalationId}. If you asked on a Crew member's behalf, send it this id.`;

/** J5's own account of a block, which the person reads apart from the agent's words. */
const recordText = (row: EscalationRow) =>
  `${row.summary} ${
    row.waivable === null
      ? "No single exception lets it run, so the cause has to be fixed."
      : `Allow this once would let one launch attempt past ${CONSTRAINT_TEXT[row.waivable]}.`
  }`;

interface EscalationRow {
  readonly id: string;
  readonly caller_participant_id: string;
  readonly persona_id: string;
  readonly code: string;
  readonly summary: string;
  readonly waivable: AgentPersonaPickConstraint | null;
  readonly scope_json: string | null;
  readonly exchange_id: string | null;
  readonly status: "open" | "granted" | "used";
}

export class AgentPersonaEscalations extends Context.Service<
  AgentPersonaEscalations,
  {
    /** Record a refused launch; returns its id. */
    readonly record: (input: {
      readonly callerParticipantId: string;
      readonly personaId: string;
      readonly code: AgentPersonaBlockCode;
      readonly summary: string;
      readonly waivable: AgentPersonaPickConstraint | null;
      /** Required with a waivable limit: what a grant may let run. */
      readonly scope: AgentPersonaWaiverScope | null;
    }) => Effect.Effect<string, SqlError | Schema.SchemaError>;
    /**
     * Whether this asker may ask about this escalation: the caller it was recorded for, or that
     * caller's Captain, and only while it is open.
     */
    readonly authorizeAsk: (input: {
      readonly escalationId: string;
      readonly askerParticipantId: string;
    }) => Effect.Effect<void, AgentPersonaEscalationError | SqlError>;
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
    /** Granted already is fine: a retried grant replays its answer and grants nothing new. */
    readonly grantable: (exchangeId: string) => Effect.Effect<
      {
        readonly escalationId: string;
        readonly personaId: string;
        readonly constraint: AgentPersonaPickConstraint;
        readonly callerParticipantId: string;
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
    }) => Effect.Effect<
      { readonly constraint: AgentPersonaPickConstraint; readonly scope: AgentPersonaWaiverScope },
      AgentPersonaEscalationError | SqlError
    >;
    /** Spend a grant on the launch it allowed; a second launch is refused. */
    readonly use: (
      escalationId: string,
    ) => Effect.Effect<void, AgentPersonaEscalationError | SqlError>;
  }
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

    const record: AgentPersonaEscalations["Service"]["record"] = Effect.fn(
      "j5.agents.escalations.record",
    )(function* (input) {
      const id = `escalation-${NodeCrypto.randomUUID()}`;
      yield* sql`
        INSERT INTO j5_persona_escalation (
          id, caller_participant_id, persona_id, code, summary, waivable, scope_json, status,
          created_at
        ) VALUES (
          ${id}, ${input.callerParticipantId}, ${input.personaId}, ${input.code},
          ${input.summary}, ${input.waivable},
          ${input.scope === null ? null : yield* encodeScope(input.scope)}, 'open', ${yield* now}
        )
      `;
      return id;
    });

    const authorizeAsk: AgentPersonaEscalations["Service"]["authorizeAsk"] = Effect.fn(
      "j5.agents.escalations.authorizeAsk",
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
    });

    const linkAsk: AgentPersonaEscalations["Service"]["linkAsk"] = (input) =>
      sql`
        UPDATE j5_persona_escalation SET exchange_id = ${input.exchangeId}
        WHERE id = ${input.escalationId}
      `.pipe(Effect.asVoid);

    const forExchanges: AgentPersonaEscalations["Service"]["forExchanges"] = Effect.fn(
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
            summary: recordText(row),
          },
        ]),
      );
    });

    const grantable: AgentPersonaEscalations["Service"]["grantable"] = Effect.fn(
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
      if (row.status === "used")
        return yield* refuse(`${row.persona_id} was already allowed once for this request.`);
      return {
        escalationId: row.id,
        personaId: row.persona_id,
        constraint: row.waivable,
        callerParticipantId: row.caller_participant_id,
      };
    });

    const markGranted: AgentPersonaEscalations["Service"]["markGranted"] = Effect.fn(
      "j5.agents.escalations.markGranted",
    )(function* (input) {
      const updated = yield* sql<{ readonly id: string }>`
        UPDATE j5_persona_escalation
        SET status = 'granted', granted_by = ${input.grantedBy}, granted_at = ${yield* now}
        WHERE id = ${input.escalationId} AND status = 'open'
        RETURNING id
      `;
      if (updated.length > 0) return;
      // A replayed grant finds it granted already, which is the outcome it asked for.
      if ((yield* read(input.escalationId)).status !== "granted")
        return yield* refuse(`Escalation ${input.escalationId} was already allowed once.`);
    });

    const grantedWaiver: AgentPersonaEscalations["Service"]["grantedWaiver"] = Effect.fn(
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
      if (row.status !== "granted" || row.waivable === null || row.scope_json === null)
        return yield* refuse(
          `allow_once ${input.escalationId} has not been allowed: only an Owner's "Allow this once" on the ask grants it, never a text reply.`,
        );
      const scope = yield* decodeScope(row.scope_json).pipe(
        Effect.mapError(() =>
          refuse(`allow_once ${input.escalationId} can't be read; ask the person again.`),
        ),
      );
      return { constraint: row.waivable, scope };
    });

    const use: AgentPersonaEscalations["Service"]["use"] = Effect.fn("j5.agents.escalations.use")(
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
      authorizeAsk,
      linkAsk,
      forExchanges,
      grantable,
      markGranted,
      grantedWaiver,
      use,
    });
  }),
);
