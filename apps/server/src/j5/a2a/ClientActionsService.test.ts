import * as NodeServices from "@effect/platform-node/NodeServices";
import { AgentPersonaEscalations } from "../agents/agentPersonaEscalation.ts";
import { agentPersonaEscalationsTestLayer } from "../test-support/agentPersonaEscalations.ts";
import { ChatAttachmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import { PlaybookStore } from "../playbooks/PlaybookStore.ts";
import { noDocumentTextLayer } from "../test-support/documentText.ts";
import type { CrewProposal } from "./AgentCrewProposalService.ts";
import {
  ArchiveCrewNotFoundError,
  ArchiveCrewService,
  type ArchiveCrewInput,
} from "./ArchiveCrewService.ts";
import { ClientActionsService, layer } from "./ClientActionsService.ts";
import { ExchangeId, LedgerMessageId, LedgerProjectId, ParticipantId } from "./contracts.ts";
import { CrewProposalNotOpenError, CrewProposalService } from "./CrewProposalService.ts";
import {
  CrewRuntimeRequestConflictError,
  CrewRuntimeRequestService,
  type RespondToCrewRuntimeRequestInput,
} from "./CrewRuntimeRequestService.ts";
import { CrewStopNotFoundError, CrewStopService, type StopCrewInput } from "./CrewStopService.ts";
import { CrewWorktrees } from "./CrewWorktrees.ts";
import { A2ADeliveryWorker } from "./DeliveryWorker.ts";
import { A2AHumanInbox } from "./HumanInboxService.ts";
import { A2AExchangeAlreadyAnsweredError } from "./SendService.ts";

const seat = (name: string) => ParticipantId.make(`agent:j5:a2a:thread:${name}`);

const proposal: CrewProposal = {
  id: "proposal:1",
  projectId: LedgerProjectId.make("project:gate"),
  captainParticipantId: seat("captain"),
  captainThreadId: ThreadId.make("thread:captain"),
  crewInstanceId: null,
  kind: "roster",
  status: "open",
  brief: "Fix the flaky login test.",
  displayName: "Login Fix Crew",
  requestedSeats: [
    { workspace: { type: "shared" }, seat: "builder", agentId: "builder", reason: "Builds" },
  ],
  approvedSeats: null,
  createdAt: "2026-09-09T16:00:00.000Z",
  resolvedAt: null,
  reportedAt: null,
  playbook: { name: "release", definitionPath: "/repo/.j5/playbooks/release.yaml" },
};

const calls = () => ({
  stops: [] as Array<StopCrewInput>,
  archives: [] as Array<ArchiveCrewInput>,
  responses: [] as Array<RespondToCrewRuntimeRequestInput>,
  answerCommandIds: [] as Array<string>,
  answerMessages: [] as Array<string>,
  // The command that answered each exchange: a replay of it succeeds, any other is refused.
  answeredBy: new Map<string, string>(),
  notified: 0,
});

const serviceWith = (seen: ReturnType<typeof calls>) =>
  layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CrewStopService)({
          stop: (input) => {
            seen.stops.push(input);
            return input.crewInstanceId === "crew:1"
              ? Effect.succeed({
                  crewInstanceId: "crew:1",
                  members: [
                    {
                      seatName: "builder",
                      participantId: seat("builder"),
                      result: "interrupt_requested" as const,
                    },
                    {
                      seatName: "ghost",
                      participantId: seat("ghost"),
                      result: "never_created" as const,
                    },
                  ],
                })
              : Effect.fail(new CrewStopNotFoundError({ crewInstanceId: input.crewInstanceId }));
          },
        }),
        Layer.mock(ArchiveCrewService)({
          archive: (input) => {
            seen.archives.push(input);
            return input.crewInstanceId === "crew:1"
              ? Effect.succeed({
                  status: "archived" as const,
                  members: [
                    {
                      seatName: "builder",
                      participantId: seat("builder"),
                      result: "archived" as const,
                    },
                    {
                      seatName: "critic",
                      participantId: seat("critic"),
                      result: "already_archived" as const,
                    },
                    {
                      seatName: "ghost",
                      participantId: seat("ghost"),
                      result: "never_created" as const,
                    },
                  ],
                  worktrees: [
                    {
                      path: "/wt/builder",
                      branch: "j5/builder",
                      outcome: "removed" as const,
                      reason: null,
                    },
                    {
                      path: "/wt/critic",
                      branch: null,
                      outcome: "kept" as const,
                      reason: "uncommitted_changes" as const,
                    },
                  ],
                })
              : Effect.fail(new ArchiveCrewNotFoundError({ crewInstanceId: input.crewInstanceId }));
          },
        }),
        Layer.mock(CrewRuntimeRequestService)({
          respond: (input) => {
            seen.responses.push(input);
            return seen.responses.length === 1
              ? Effect.void
              : Effect.fail(new CrewRuntimeRequestConflictError({ detail: "already resolved" }));
          },
        }),
        Layer.mock(CrewProposalService)({
          resolve: (input) =>
            input.proposalId === proposal.id
              ? Effect.succeed({
                  proposal: { ...proposal, status: "approved" as const },
                  instance: null,
                })
              : Effect.fail(
                  new CrewProposalNotOpenError({
                    proposalId: input.proposalId,
                    status: "declined",
                  }),
                ),
        }),
        Layer.mock(PlaybookStore)({
          readPath: () =>
            Effect.succeed({
              name: "release",
              title: "Release",
              description: "Ship.",
              steps: [{ id: "plan", title: "Plan", prompt: "Plan." }],
              warnings: [],
            }),
        }),
        Layer.mock(A2AHumanInbox)({
          answer: (input, _beforeReply, claimAttachments) => {
            const answeredBy = seen.answeredBy.get(input.exchangeId);
            if (answeredBy !== undefined && answeredBy !== input.commandId)
              return Effect.fail(
                new A2AExchangeAlreadyAnsweredError({ exchangeId: input.exchangeId }),
              );
            seen.answeredBy.set(input.exchangeId, input.commandId);
            seen.answerCommandIds.push(input.commandId);
            seen.answerMessages.push(input.message);
            const claim =
              input.attachments === undefined || claimAttachments === undefined
                ? Effect.void
                : claimAttachments(ThreadId.make("thread:asker"), input.attachments);
            return claim.pipe(
              Effect.as({
                messageId: LedgerMessageId.make(`message:test:${input.exchangeId}`),
                exchangeId: input.exchangeId,
                exchangeState: "closed" as const,
                joinedExistingExchange: false,
                durableAtSeq: 1,
              }),
            );
          },
        }),
        Layer.mock(A2ADeliveryWorker)({
          notify: Effect.sync(() => {
            seen.notified += 1;
          }),
        }),
        Layer.mock(CrewWorktrees)({}),
        noDocumentTextLayer,
      ),
    ),
    // Exposed too, so a test files the escalation an ask carries.
    Layer.provideMerge(agentPersonaEscalationsTestLayer()),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "j5-client-actions-" })),
    Layer.provide(NodeServices.layer),
  );

it.effect(
  "stops a Crew as a person: no Captain check, fresh per-seat ids, created seats only",
  () => {
    const seen = calls();
    return Effect.gen(function* () {
      const actions = yield* ClientActionsService;
      const stopped = yield* actions.stopCrew({ crewInstanceId: "crew:1" });
      // The never-created ghost seat is left out, so every client decodes the members it gets.
      assert.deepStrictEqual(stopped, {
        crewInstanceId: "crew:1",
        members: [
          { seat: "builder", participantId: seat("builder"), result: "interrupt_requested" },
        ],
      });
      yield* actions.stopCrew({ crewInstanceId: "crew:1" });
      const [first, second] = seen.stops;
      assert.isNull(first?.callerParticipantId);
      assert.isNull(first?.projectId);
      assert.notEqual(
        first?.commandIds("builder").interruptCommandId,
        first?.commandIds("critic").interruptCommandId,
      );
      // Each click is one stop: two clicks cannot share command ids.
      assert.notEqual(
        first?.commandIds("builder").interruptCommandId,
        second?.commandIds("builder").interruptCommandId,
      );
      const missing = yield* actions.stopCrew({ crewInstanceId: "crew:nope" }).pipe(Effect.flip);
      assert.equal(missing._tag, "CrewStopNotFoundError");
    }).pipe(Effect.provide(serviceWith(seen)));
  },
);

it.effect("archives a Crew as a person, with the dialog's confirmation already satisfied", () => {
  const seen = calls();
  return Effect.gen(function* () {
    const actions = yield* ClientActionsService;
    const archived = yield* actions.archiveCrew({ crewInstanceId: "crew:1" });
    assert.equal(archived.status, "archived");
    assert.deepStrictEqual(
      archived.members.map((member) => [member.seat, member.result]),
      [
        ["builder", "archived"],
        ["critic", "already_archived"],
      ],
    );
    assert.deepStrictEqual(
      archived.worktrees.map((entry) => [entry.path, entry.outcome, entry.reason]),
      [
        ["/wt/builder", "removed", null],
        ["/wt/critic", "kept", "uncommitted_changes"],
      ],
    );
    // A person is not a participant and confirmed the dialog: no Captain check, no token dance.
    const [input] = seen.archives;
    assert.isNull(input?.callerParticipantId);
    assert.isNull(input?.projectId);
    assert.isTrue(input?.confirmationSatisfied);
    assert.isUndefined(input?.confirmationToken);
    assert.notEqual(
      input?.commandIds("builder").archiveCommandId,
      input?.commandIds("critic").archiveCommandId,
    );
    assert.notEqual(
      input?.commandIds("builder").archiveCommandId,
      input?.commandIds("builder").interruptCommandId,
    );
    const missing = yield* actions.archiveCrew({ crewInstanceId: "crew:nope" }).pipe(Effect.flip);
    assert.equal(missing._tag, "ArchiveCrewNotFoundError");
  }).pipe(Effect.provide(serviceWith(seen)));
});

it.effect("answers a seat's approval with its own command id, so a repeat is refused", () => {
  const seen = calls();
  return Effect.gen(function* () {
    const actions = yield* ClientActionsService;
    const answer = {
      threadId: ThreadId.make("thread:builder"),
      requestId: RuntimeRequestId.make("req:1"),
      decision: "accept" as const,
    };
    assert.deepStrictEqual(yield* actions.respondCrewRuntimeRequest(answer), {
      threadId: answer.threadId,
      requestId: answer.requestId,
    });
    const repeat = yield* actions.respondCrewRuntimeRequest(answer).pipe(Effect.flip);
    assert.equal(repeat._tag, "CrewRuntimeRequestConflictError");
    assert.lengthOf(seen.responses, 2);
    assert.notEqual(seen.responses[0]!.commandId, seen.responses[1]!.commandId);
  }).pipe(Effect.provide(serviceWith(seen)));
});

it.effect("resolves a proposal and answers with it as the card reads it", () => {
  const seen = calls();
  return Effect.gen(function* () {
    const actions = yield* ClientActionsService;
    const resolved = yield* actions.resolveCrewProposal({
      proposalId: proposal.id,
      decision: "approve",
      approvalToken: "runtime-token",
    });
    assert.equal(resolved.proposal.status, "approved");
    assert.isNull(resolved.crewInstanceId);
    // The stored reference becomes the live definition's summary.
    assert.deepStrictEqual(resolved.proposal.playbook, {
      name: "release",
      title: "Release",
      steps: [{ id: "plan", title: "Plan" }],
      issue: null,
    });
    const stale = yield* actions
      .resolveCrewProposal({ proposalId: "other", decision: "decline" })
      .pipe(Effect.flip);
    assert.equal(stale._tag, "CrewProposalNotOpenError");
  }).pipe(Effect.provide(serviceWith(seen)));
});

it.effect(
  "answers an Exchange under a command id of person, exchange and request, then wakes delivery",
  () => {
    const seen = calls();
    return Effect.gen(function* () {
      const actions = yield* ClientActionsService;
      const personId = ParticipantId.make("human:local-operator");
      const first = ExchangeId.make("exchange:same-client:first");
      const second = ExchangeId.make("exchange:same-client:second");
      const clientRequestId = "reused-client-request";
      for (const exchangeId of [first, second]) {
        const answered = yield* actions.answerHumanExchange({
          personId,
          exchangeId,
          message: `Answer for ${exchangeId}`,
          clientRequestId,
        });
        assert.equal(answered.result.exchangeId, exchangeId);
      }
      // One client request id reused across two Exchanges still makes two commands.
      assert.deepStrictEqual(seen.answerCommandIds, [
        `command:j5:a2a:human:${encodeURIComponent(personId)}:${encodeURIComponent(first)}:${encodeURIComponent(clientRequestId)}`,
        `command:j5:a2a:human:${encodeURIComponent(personId)}:${encodeURIComponent(second)}:${encodeURIComponent(clientRequestId)}`,
      ]);
      assert.equal(seen.notified, 2);
    }).pipe(Effect.provide(serviceWith(seen)));
  },
);

it.effect(
  "allows a blocked persona once: the fixed reply answers the ask, then it is granted",
  () => {
    const seen = calls();
    return Effect.gen(function* () {
      const actions = yield* ClientActionsService;
      const escalations = yield* AgentPersonaEscalations;
      const owner = ParticipantId.make("human:owner");
      const file = (exchangeId: string, waivable: "access-above-caller" | null) =>
        escalations
          .record({
            callerParticipantId: "agent:j5:a2a:thread:asker",
            personaId: "reviewer",
            code: "models_exhausted",
            summary: "Persona reviewer is blocked.",
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
          })
          .pipe(Effect.tap((escalationId) => escalations.linkAsk({ escalationId, exchangeId })));
      const escalationId = yield* file("exchange:blocked", "access-above-caller");
      yield* actions.allowPersonaOnce({
        personId: owner,
        exchangeId: "exchange:blocked",
        clientRequestId: "allow-1",
      });
      assert.deepStrictEqual(seen.answerMessages, [
        `Allowed once: reviewer past broader access than its caller runs with. Only agent:j5:a2a:thread:asker, whose launch was refused, can use it: it retries that launch with allow_once: ${escalationId}. If you asked on a Crew member's behalf, send it this id.`,
      ]);
      assert.equal(
        (yield* escalations.grantedWaiver({
          escalationId,
          callerParticipantId: "agent:j5:a2a:thread:asker",
          personaId: "reviewer",
        })).constraint,
        "access-above-caller",
      );
      // A retry whose reply was lost replays the same answer and succeeds; another press is
      // refused by the answered ask, and one on an ask no single waiver helps answers nothing.
      yield* actions.allowPersonaOnce({
        personId: owner,
        exchangeId: "exchange:blocked",
        clientRequestId: "allow-1",
      });
      const again = yield* actions
        .allowPersonaOnce({
          personId: owner,
          exchangeId: "exchange:blocked",
          clientRequestId: "allow-2",
        })
        .pipe(Effect.flip);
      assert.equal(again._tag, "A2AExchangeAlreadyAnsweredError");
      yield* file("exchange:stuck", null);
      const stuck = yield* actions
        .allowPersonaOnce({
          personId: owner,
          exchangeId: "exchange:stuck",
          clientRequestId: "allow-3",
        })
        .pipe(Effect.flip);
      assert.include(stuck.message, "can't be allowed once");
      assert.lengthOf(new Set(seen.answerCommandIds), 1);
    }).pipe(Effect.provide(serviceWith(seen)));
  },
);

it.effect("refuses an answer attachment that is not a new upload", () => {
  const seen = calls();
  return Effect.gen(function* () {
    const actions = yield* ClientActionsService;
    const refused = yield* actions
      .answerHumanExchange({
        personId: ParticipantId.make("human:local-operator"),
        exchangeId: ExchangeId.make("exchange:with-file"),
        message: "See the screenshot.",
        // A file stored on another thread, named by its id.
        attachments: [
          {
            type: "image",
            id: ChatAttachmentId.make("thread-other-00000000-0000-4000-8000-000000000000"),
            name: "secret.png",
            mimeType: "image/png",
            sizeBytes: 10,
          },
        ],
        clientRequestId: "with-file",
      })
      .pipe(Effect.flip);
    assert.equal(refused._tag, "AttachmentClaimError");
    assert.equal(seen.notified, 0);
  }).pipe(Effect.provide(serviceWith(seen)));
});
