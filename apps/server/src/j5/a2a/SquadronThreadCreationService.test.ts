import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { A2AHomeNotFoundError, A2AHomeRegistrar } from "./HomeRegistrar.ts";
import {
  SquadronThreadCreationMissingSquadronError,
  SquadronThreadCreationProjectReferenceError,
  SquadronThreadCreationService,
  layer as squadronThreadCreationServiceLayer,
} from "./SquadronThreadCreationService.ts";
import { SquadronProjectReferences } from "./SquadronProjectReferences.ts";
import { ParticipantId, SquadronId } from "./contracts.ts";

const squadronId = SquadronId.make("squadron:creation");
const projectId = ProjectId.make("project:creation");
const otherProjectId = ProjectId.make("project:other");
const threadId = ThreadId.make("thread:creation");
const commandId = CommandId.make("command:creation");
const createdAt = "2026-08-29T20:00:00.000Z";

const input = {
  squadronId,
  commandId,
  threadId,
  projectId,
  createdAt,
};

const makeLayer = (input: {
  readonly references: ReadonlyArray<ProjectId>;
  readonly register?: A2AHomeRegistrar["Service"]["registerAtCreation"];
  readonly getHomeForThread?: A2AHomeRegistrar["Service"]["getHomeForThread"];
}) => {
  const references = Layer.mock(SquadronProjectReferences)({
    listForSquadron: () =>
      Effect.succeed(
        input.references.map((candidateProjectId, ordinal) => ({
          squadronId,
          projectId: candidateProjectId,
          ordinal,
          createdAt,
        })),
      ),
  });
  const registrar = Layer.mock(A2AHomeRegistrar)({
    registerAtCreation:
      input.register ??
      (() =>
        Effect.succeed({
          squadronId,
          participantId: ParticipantId.make(`agent:${threadId}`),
        })),
    getHomeForThread:
      input.getHomeForThread ??
      (() =>
        Effect.succeed({
          squadronId,
          participantId: ParticipantId.make(`agent:${threadId}`),
        })),
  });
  return squadronThreadCreationServiceLayer.pipe(
    Layer.provideMerge(references),
    Layer.provideMerge(registrar),
  );
};

it.effect("refuses a durable thread launch without an explicit Squadron", () =>
  Effect.gen(function* () {
    const service = yield* SquadronThreadCreationService;
    const { squadronId: _squadronId, ...withoutSquadron } = input;
    const error = yield* service.registerAtDurableLaunch(withoutSquadron).pipe(Effect.flip);
    assert.instanceOf(error, SquadronThreadCreationMissingSquadronError);
  }).pipe(Effect.provide(makeLayer({ references: [projectId] }))),
);

it.effect("preserves a missing parent Registrar home as explicit native legacy state", () =>
  Effect.gen(function* () {
    const service = yield* SquadronThreadCreationService;
    const home = yield* service.findRegisteredHome(threadId);
    assert.isNull(home);
  }).pipe(
    Effect.provide(
      makeLayer({
        references: [projectId],
        getHomeForThread: () => Effect.fail(new A2AHomeNotFoundError({ threadId })),
      }),
    ),
  ),
);

it.effect("refuses unreferenced and ambiguous project selections without inference", () =>
  Effect.gen(function* () {
    const service = yield* SquadronThreadCreationService;
    const error = yield* service
      .registerAtDurableLaunch({ ...input, projectId: otherProjectId })
      .pipe(Effect.flip);
    assert.instanceOf(error, SquadronThreadCreationProjectReferenceError);
    assert.deepStrictEqual(error.referencedProjectIds, [projectId]);
  }).pipe(Effect.provide(makeLayer({ references: [projectId] }))),
);

it.effect(
  "replays the exact durable registration inputs without launching or preparing again",
  () => {
    const registrations: Array<Parameters<A2AHomeRegistrar["Service"]["registerAtCreation"]>[0]> =
      [];
    return Effect.gen(function* () {
      const service = yield* SquadronThreadCreationService;
      yield* service.registerAtDurableLaunch(input);
      yield* service.registerAtDurableLaunch(input);
      assert.deepStrictEqual(registrations, [
        {
          squadronId,
          threadId,
          createdAt,
          commandId: "command:j5:a2a:thread-creation:command%3Acreation",
        },
        {
          squadronId,
          threadId,
          createdAt,
          commandId: "command:j5:a2a:thread-creation:command%3Acreation",
        },
      ]);
    }).pipe(
      Effect.provide(
        makeLayer({
          references: [projectId],
          register: (registration) => {
            registrations.push(registration);
            return Effect.succeed({
              squadronId,
              participantId: ParticipantId.make(`agent:${threadId}`),
            });
          },
        }),
      ),
    );
  },
);
