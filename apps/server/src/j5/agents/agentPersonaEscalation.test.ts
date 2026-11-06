import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  AgentCrewInstanceService,
  type AgentCrewInstance,
} from "../a2a/AgentCrewInstanceService.ts";
import { agentPersonaEscalationsTestLayer } from "../test-support/agentPersonaEscalations.ts";
import { AgentPersonaEscalations, personaBlockText } from "./agentPersonaEscalation.ts";

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
    });
  });

it.layer(agentPersonaEscalationsTestLayer(crews))("persona escalations", (it) => {
  it.effect("an ask carries the server's record, from the caller or its Captain only", () =>
    Effect.gen(function* () {
      const escalations = yield* AgentPersonaEscalations;
      const id = yield* record("model-not-eligible");
      const own = yield* escalations.askSummary({ escalationId: id, askerParticipantId: member });
      assert.include(own, `escalation ${id}, models_exhausted`);
      assert.include(own, "An Owner can allow it once");
      // The Captain asks the person on its member's behalf.
      assert.equal(
        yield* escalations.askSummary({ escalationId: id, askerParticipantId: captain }),
        own,
      );
      // Another Crew's Captain cannot.
      const refused = yield* escalations
        .askSummary({ escalationId: id, askerParticipantId: otherCaptain })
        .pipe(Effect.flip);
      assert.include(refused.message, "is another agent's");

      yield* escalations.linkAsk({ escalationId: id, exchangeId: "exchange:ask" });
      assert.deepEqual((yield* escalations.forExchanges(["exchange:ask"])).get("exchange:ask"), {
        escalationId: id,
        personaId: "reviewer",
        waivable: "model-not-eligible",
        status: "open",
      });
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
      });
      yield* escalations.markGranted({ escalationId: id, grantedBy: "human:owner" });
      assert.include(
        (yield* escalations.grantable("exchange:grant").pipe(Effect.flip)).message,
        "already allowed once",
      );

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
      assert.equal(yield* escalations.grantedWaiver(waiver), "model-not-eligible");

      // One launch spends it; the next is refused.
      yield* escalations.use(id);
      assert.include(
        (yield* escalations.grantedWaiver(waiver).pipe(Effect.flip)).message,
        "already used",
      );
      assert.include((yield* escalations.use(id).pipe(Effect.flip)).message, "already used");
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
});
