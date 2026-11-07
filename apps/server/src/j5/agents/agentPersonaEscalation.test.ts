import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import {
  AgentCrewInstanceService,
  type AgentCrewInstance,
} from "../a2a/AgentCrewInstanceService.ts";
import { runJ5A2AMigrations } from "../a2a/Migrations.ts";
import { AgentPersonaEscalations, layer, personaBlockText } from "./agentPersonaEscalation.ts";

const member = "agent:j5:a2a:thread:member";
const captain = "agent:j5:a2a:thread:captain";
const otherCaptain = "agent:j5:a2a:thread:other-captain";

// The member sits on one Crew, commanded by `captain`.
const crews = Layer.mock(AgentCrewInstanceService)({
  findMembership: (participantId) =>
    Effect.succeed(
      participantId === member ? { crewInstanceId: "crew:1", seatName: "reviewer" } : null,
    ),
  read: (id) =>
    Effect.succeed(
      id === "crew:1" ? ({ captainParticipantId: captain } as unknown as AgentCrewInstance) : null,
    ),
});

const record = (waivable: "model-not-eligible" | null) =>
  Effect.gen(function* () {
    return yield* (yield* AgentPersonaEscalations).record({
      callerParticipantId: member,
      personaId: "reviewer",
      code: "models_exhausted",
      summary: "Persona reviewer is blocked because none of its model entries can run.",
      waivable,
      scope:
        waivable === null
          ? null
          : {
              definitionDigest: "digest",
              entries: [
                {
                  entryIndex: 0,
                  instanceId: "codex",
                  model: "gpt-6",
                  options: [],
                  runtimeMode: "full-access",
                },
              ],
            },
    });
  });

// The store on a migrated database the tests can also read and write, for the asks it links.
const escalations = layer.pipe(
  Layer.provideMerge(
    Layer.effectDiscard(runJ5A2AMigrations()).pipe(
      Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
  ),
  Layer.provide(crews),
  Layer.orDie,
);

it.layer(escalations)("persona escalations", (it) => {
  it.effect("the caller or its Captain may ask, and the ask carries J5's own record", () =>
    Effect.gen(function* () {
      const escalations = yield* AgentPersonaEscalations;
      const id = yield* record("model-not-eligible");
      yield* escalations.authorizeAsk({ escalationId: id, askerParticipantId: member });
      // The Captain asks the person on its member's behalf; another Crew's Captain cannot.
      yield* escalations.authorizeAsk({ escalationId: id, askerParticipantId: captain });
      const refused = yield* escalations
        .authorizeAsk({ escalationId: id, askerParticipantId: otherCaptain })
        .pipe(Effect.flip);
      assert.include(refused.message, "is another agent's");

      yield* escalations.linkAsk({ escalationId: id, exchangeId: "exchange:ask" });
      assert.deepEqual((yield* escalations.forExchanges(["exchange:ask"])).get("exchange:ask"), {
        escalationId: id,
        personaId: "reviewer",
        waivable: "model-not-eligible",
        status: "open",
        summary:
          "Persona reviewer is blocked because none of its model entries can run. Allow this once would let one launch attempt past a model Models for custom members doesn't check.",
      });
    }),
  );

  it.effect("an escalation on an open ask can't go on another until that ask closes", () =>
    Effect.gen(function* () {
      const escalations = yield* AgentPersonaEscalations;
      const sql = yield* SqlClient.SqlClient;
      const id = yield* record("model-not-eligible");
      yield* sql`INSERT INTO j5_a2a_project_ledger (project_id, created_at)
        VALUES ('p', '2026-11-07T00:00:00.000Z')`;
      yield* sql`INSERT INTO j5_a2a_exchange (
        project_id, exchange_id, sender_id, receiver_id, status, intent, opened_seq, created_at,
        updated_at
      ) VALUES ('p', 'exchange:first', ${member}, 'human:owner', 'open', 'May reviewer run?', 1,
        '2026-11-07T00:00:00.000Z', '2026-11-07T00:00:00.000Z')`;
      yield* escalations.linkAsk({ escalationId: id, exchangeId: "exchange:first" });

      const refused = yield* escalations
        .authorizeAsk({ escalationId: id, askerParticipantId: member })
        .pipe(Effect.flip);
      assert.include(refused.message, "already on open ask exchange:first");
      assert.include(refused.message, "regarding=exchange:first and without escalation_id");
      assert.include(refused.message, "j5_clear_own_ask");

      // Answered in words or cleared, the ask is closed, and a new ask may carry it.
      yield* sql`UPDATE j5_a2a_exchange SET status = 'closed' WHERE exchange_id = 'exchange:first'`;
      yield* escalations.authorizeAsk({ escalationId: id, askerParticipantId: member });
    }),
  );

  it.effect("a grant allows one launch for its caller and persona, and nothing else", () =>
    Effect.gen(function* () {
      const escalations = yield* AgentPersonaEscalations;
      const id = yield* record("model-not-eligible");
      yield* escalations.linkAsk({ escalationId: id, exchangeId: "exchange:grant" });
      const waiver = { escalationId: id, callerParticipantId: member, personaId: "reviewer" };

      // A text reply records nothing, so the retry is refused until the Owner grants it.
      assert.include(
        (yield* escalations.grantedWaiver(waiver).pipe(Effect.flip)).message,
        "never a text reply",
      );
      const grant = yield* escalations.grantable("exchange:grant");
      assert.deepEqual(grant, {
        escalationId: id,
        personaId: "reviewer",
        constraint: "model-not-eligible",
        callerParticipantId: member,
      });
      yield* escalations.markGranted({ escalationId: id, grantedBy: "human:owner" });
      // A replayed grant still finds it grantable and grants nothing new.
      assert.deepEqual(yield* escalations.grantable("exchange:grant"), grant);
      yield* escalations.markGranted({ escalationId: id, grantedBy: "human:owner" });

      // Bound to the caller and the persona it was granted for.
      assert.include(
        (yield* escalations
          .grantedWaiver({ ...waiver, callerParticipantId: captain })
          .pipe(Effect.flip)).message,
        "another caller",
      );
      assert.include(
        (yield* escalations.grantedWaiver({ ...waiver, personaId: "builder" }).pipe(Effect.flip))
          .message,
        "is for persona reviewer",
      );
      assert.equal((yield* escalations.grantedWaiver(waiver)).constraint, "model-not-eligible");

      // One launch spends it; the next is refused.
      yield* escalations.use(id);
      assert.include(
        (yield* escalations.grantedWaiver(waiver).pipe(Effect.flip)).message,
        "already used",
      );
      assert.include((yield* escalations.use(id).pipe(Effect.flip)).message, "already used");
      assert.include(
        (yield* escalations.grantable("exchange:grant").pipe(Effect.flip)).message,
        "already allowed once",
      );
    }),
  );

  it.effect("an escalation no single waiver lets run can't be granted", () =>
    Effect.gen(function* () {
      const escalations = yield* AgentPersonaEscalations;
      const id = yield* record(null);
      yield* escalations.linkAsk({ escalationId: id, exchangeId: "exchange:none" });
      assert.include(
        (yield* escalations.grantable("exchange:none").pipe(Effect.flip)).message,
        "can't be allowed once",
      );
      assert.include(
        (yield* escalations.grantable("exchange:plain").pipe(Effect.flip)).message,
        "doesn't escalate a blocked persona",
      );
    }),
  );
});

it("tells an outside agent to tell the person, and everyone else how to escalate", () => {
  const block = {
    code: "persona_disabled" as const,
    detail: "Persona reviewer is disabled in this environment.",
    waivable: null,
  };
  const outside = personaBlockText({ ...block, escalationId: null });
  assert.include(outside, "[persona_disabled] Persona reviewer is disabled");
  assert.include(outside, "Never recreate a blocked persona as a custom worker");
  assert.include(outside, "Tell the person directly.");
  assert.notInclude(outside, "escalation_id");
  const inside = personaBlockText({ ...block, escalationId: "escalation-1" });
  assert.include(inside, "escalation_id: escalation-1.");
  assert.include(inside, "tells its Captain");
  assert.notInclude(inside, "allow_once");
  const waivable = personaBlockText({
    ...block,
    code: "models_exhausted",
    escalationId: "escalation-1",
    waivable: "access-above-caller",
  });
  assert.include(waivable, "with a button on your ask; a typed reply never allows it");
  assert.include(waivable, "retry the same launch with allow_once");
});
