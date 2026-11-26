import { makeCrewFailureAlert } from "./crewFailureAlert.ts";
import { layer as sharedThreadsLayer } from "../sharing/SharedThreads.ts";
import {
  MessageId,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { AgentCrewInstanceService, type AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import { CrewLaunchReporter } from "./CrewLaunchReporter.ts";
import { PlaybookCrewRelay } from "../playbooks/PlaybookCrewRelay.ts";
import { CrewCaptainArchiveCascade } from "./CrewCaptainArchiveCascade.ts";
import { readEventStoreHighWater } from "./eventStoreHighWater.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { formatRunFailureField, runFailureDetail } from "./runFailures.ts";
import { lifecycleCommandId, lifecycleId } from "./spawnIds.ts";

/**
 * A seat's failed run tells its Captain, with the run's error and the seat's reply; a completed run
 * tells nothing, as the seat reports its own result. The seat is never settled. Each run is told
 * once, and a notice arriving mid-turn folds into the seat notice already queued.
 */
export interface CrewSeatFinishNotifierShape {
  /** Returns the seat thread whose Captain was told, or null when the event needed no action. */
  readonly handleStoredEvent: (
    event: OrchestrationV2StoredEvent,
  ) => Effect.Effect<ThreadId | null, never>;
  /**
   * The boot sweep: tell every Captain about a live seat whose last run failed while nothing
   * reported it. Covers a notice that failed (the seat was left unreported on purpose) and a
   * failure that landed while the server was down. Returns the seat threads reported.
   */
  readonly reconcile: Effect.Effect<ReadonlyArray<ThreadId>>;
}

export class CrewSeatFinishNotifier extends Context.Service<
  CrewSeatFinishNotifier,
  CrewSeatFinishNotifierShape
>()("t3/j5/a2a/CrewSeatFinishNotifier") {}

const FINISH_SESSION = "j5-crew-seat-finish";
/** A longer reply is cut in the Captain's notice; the rest is in the seat's own thread. */
const REPLY_MAX_CHARS = 4_000;

/**
 * Only a failed run is reported. A completed run was 90% noise to its Captain, who hears the result
 * from the seat itself. Interrupted, cancelled and rolled back runs are not failures:
 * `j5_stop_crew` and Stop crew interrupt seats to brief them again (Crews AC21).
 */
const failedRun = (stored: OrchestrationV2StoredEvent): OrchestrationV2Run | undefined => {
  const event = stored.event;
  return event.type === "run.updated" && event.payload.status === "failed"
    ? event.payload
    : undefined;
};

const NOTICE_OPEN = "<j5_seat_finished>";

/** Each seat's section of a notice or digest: its opening tag through the text before the next. */
export const seatNoticeSections = (text: string): ReadonlyArray<string> =>
  text
    .split(NOTICE_OPEN)
    .slice(1)
    .map((part) => `${NOTICE_OPEN}${part}`.trim());

const sectionParticipant = (section: string) =>
  /^participant_id: (.+)$/m.exec(section)?.[1]?.trim() ?? null;

/**
 * The newest notice the Captain already holds for a seat, delivered or still queued. Keyed by
 * the seat's participant, not its name: one Captain commands several Crews and they reuse names
 * (reviewer, builder), so two Crews' reviewers must not replace each other's baseline.
 */
export const latestSeatNotice = (
  captain: Pick<OrchestrationV2ThreadProjection, "messages">,
  participantId: string,
): string | null => {
  const newestFirst = captain.messages
    .filter((message) => message.role === "user" && message.createdBy === "system")
    .toSorted((a, b) => DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt));
  for (const message of newestFirst) {
    const sections = seatNoticeSections(message.text).filter(
      (section) => sectionParticipant(section) === participantId,
    );
    if (sections.length > 0) return sections[sections.length - 1] ?? null;
  }
  return null;
};

/** A seat notice still queued behind the Captain's running turn; a new notice folds into it. */
export const queuedSeatDigest = (
  captain: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
) => {
  if (ThreadManagement.latestActiveRun(captain) === undefined) return null;
  for (const run of captain.runs) {
    if (run.status !== "queued") continue;
    const message = captain.messages.find((item) => item.id === run.userMessageId);
    if (
      message?.role === "user" &&
      message.createdBy === "system" &&
      message.text.startsWith(NOTICE_OPEN)
    )
      return { run, message };
  }
  return null;
};

/**
 * A seat's reply must not be able to end the reply block and continue as platform voice, nor open
 * a seat section of its own: a Critic reviewing this feature will quote a notice, and both the
 * notifier's sections and the card's parser split on the opening tag.
 */
const noticeReply = (reply: string) =>
  reply
    .replace(/<\/seat_reply>/g, "<\\/seat_reply>")
    .replace(/<j5_seat_finished>/g, "<\\j5_seat_finished>");

/**
 * The platform-composed notice the Captain receives when a seat finishes: measured facts about
 * the run, then the seat's reply when it wrote one.
 */
export const seatFinishedNoticeText = (input: {
  readonly seatName: string;
  /** Which Crew the seat sits in; a Captain may command several. */
  readonly crewName: string;
  readonly participantId: string;
  readonly threadId: string;
  /** Makes each run's notice distinct, so only the same run reported twice reads as unchanged. */
  readonly runId: string;
  readonly runStatus: string;
  /** The run's recorded error when it failed; the notice leads with it. */
  readonly failure: OrchestrationV2ProviderFailure | null;
  readonly reply: string | null;
}) => {
  const failureLine =
    input.runStatus === "failed" ? `\nfailure: ${formatRunFailureField(input.failure)}` : "";
  const head = `<j5_seat_finished>\nrun_status: ${input.runStatus}${failureLine}\nseat: ${input.seatName}\ncrew: ${input.crewName}\nparticipant_id: ${input.participantId}\nthread_id: ${input.threadId}\nrun_id: ${input.runId}\n</j5_seat_finished>`;
  if (input.reply === null) return head;
  const cut = input.reply.length > REPLY_MAX_CHARS;
  // Never leave half of a surrogate pair at the cut.
  const body = cut
    ? input.reply.slice(0, REPLY_MAX_CHARS).replace(/[\uD800-\uDBFF]$/, "")
    : input.reply;
  return `${head}\n\n<seat_reply>\n${noticeReply(body)}${cut ? `\n[reply cut at ${REPLY_MAX_CHARS} characters; the rest is in the seat's thread]` : ""}\n</seat_reply>`;
};

/**
 * The seat's reply for a run: its last finished assistant message with any text. Turn-item order
 * decides, because providers can finalize messages with identical timestamps; timestamps break
 * the tie only when no turn item names a message.
 */
const runReply = (
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "turnItems">,
): string | null => {
  const messages = projection.messages.filter(
    (message) => message.role === "assistant" && !message.streaming && message.text.trim() !== "",
  );
  const lastItem = projection.turnItems
    .flatMap((item) => (item.type === "assistant_message" && item.text.trim() !== "" ? [item] : []))
    .toSorted((a, b) => b.ordinal - a.ordinal)[0];
  const message =
    messages.find((candidate) => candidate.id === lastItem?.messageId) ??
    messages.toSorted(
      (a, b) =>
        DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt) ||
        DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt),
    )[0];
  return message?.text.trim() ?? null;
};

const makeLayer = (daemon: boolean) =>
  Layer.effect(
    CrewSeatFinishNotifier,
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const alertHumanOfCrewFailure = yield* makeCrewFailureAlert;
      const crews = yield* AgentCrewInstanceService;
      const reporter = yield* CrewLaunchReporter;
      const cascade = yield* CrewCaptainArchiveCascade;

      /**
       * Tells the Captain what changed. Ids derive from the run, so a redelivered event cannot
       * post twice; a fold checks the digest for the same text for the same reason.
       */
      const notifyCaptain = Effect.fn("j5.a2a.crewSeatFinish.notifyCaptain")(function* (
        instance: AgentCrewInstance,
        seatName: string,
        projection: Pick<OrchestrationV2ThreadProjection, "thread" | "turnItems">,
        run: OrchestrationV2Run,
        reply: string | null,
      ) {
        const threadId = projection.thread.id;
        // Seat notices are system-authored user messages; the digest is a queued run's user message.
        const captain = yield* threads.getThreadRecords(
          instance.captainThreadId,
          ["runs", "messages"],
          { messageRoles: ["user"] },
        );
        const stable = { providerSessionId: FINISH_SESSION, requestKey: `${threadId}:${run.id}` };
        const text = seatFinishedNoticeText({
          seatName,
          crewName: instance.displayName,
          participantId: participantIdForThread(threadId),
          threadId,
          runId: run.id,
          runStatus: run.status,
          failure: runFailureDetail(projection, run.id),
          reply,
        });
        if (latestSeatNotice(captain, participantIdForThread(threadId)) === text.trim())
          return "unchanged" as const;
        const digest = queuedSeatDigest(captain);
        if (digest !== null) {
          if (!digest.message.text.includes(text)) {
            yield* threads.dispatch({
              type: "queued-run.edit",
              commandId: lifecycleCommandId({ ...stable, operation: "seat-finished-fold" }),
              threadId: instance.captainThreadId,
              runId: digest.run.id,
              text: `${digest.message.text}\n\n${text}`,
            });
          }
          return "folded" as const;
        }
        yield* threads.dispatch({
          type: "message.dispatch",
          createdBy: "system",
          creationSource: "server",
          commandId: lifecycleCommandId({ ...stable, operation: "seat-finished" }),
          threadId: instance.captainThreadId,
          messageId: MessageId.make(
            lifecycleId({ ...stable, kind: "message", operation: "seat-finished" }),
          ),
          text,
          attachments: [],
          modelSelection: captain.thread.modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        return "posted" as const;
      });

      const notifyIfFailed = Effect.fn("j5.a2a.crewSeatFinish.notifyIfFailed")(function* (
        threadId: ThreadId,
        run: OrchestrationV2Run,
      ) {
        const membership = yield* crews.findMembership(participantIdForThread(threadId));
        if (membership === null) return null;
        const instance = yield* crews.read(membership.crewInstanceId);
        if (instance === null || instance.archivedAt !== null) return null;
        const projection = yield* threads.getThreadRecords(
          threadId,
          ["runs", "turnItems", "messages"],
          {
            turnItemRunId: run.id,
            turnItemTypes: ["error", "assistant_message"],
            messageRoles: ["assistant"],
            messageRunIds: [run.id],
          },
        );
        if (projection.thread.archivedAt !== null) return null;
        if (ThreadManagement.latestActiveRun(projection) !== undefined) return null;
        yield* alertHumanOfCrewFailure({
          instance,
          seatName: membership.seatName,
          runId: run.id,
          failure: runFailureDetail(projection, run.id),
        });
        // A failed first turn belongs to an owed launch report, or to the exact run ids in
        // its durable message. This remains true after the report posts and after restart.
        if (yield* reporter.coversFailure(threadId, run)) return null;
        // Reported whatever the seat owes: the silence detector stays quiet about a seat's
        // failure to its Captain, so this is where the Captain hears it. A failed dispatch is
        // logged; retry is passive (a later failure or the boot sweep).
        yield* notifyCaptain(instance, membership.seatName, projection, run, runReply(projection));
        return threadId;
      });

      /** Only report the latest run, never an older failure hidden behind a later run. */
      const outstandingFailure = (projection: Pick<OrchestrationV2ThreadProjection, "runs">) => {
        if (ThreadManagement.latestActiveRun(projection) !== undefined) return undefined;
        const newest = projection.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
        return newest?.status === "failed" ? newest : undefined;
      };

      const reconcile: CrewSeatFinishNotifierShape["reconcile"] = Effect.gen(function* () {
        const reportedNow: Array<ThreadId> = [];
        for (const instance of yield* crews.listLive()) {
          for (const member of instance.members) {
            // A seat whose thread cannot be read (gone, or the store hiccuped) is skipped this pass.
            const projection = yield* threads
              .getThreadRecords(member.threadId, ["runs"])
              .pipe(Effect.catchCause(() => Effect.succeed(null)));
            if (projection === null) continue;
            if (projection.thread.archivedAt !== null) continue;
            const run = outstandingFailure(projection);
            if (run === undefined) continue;
            const outcome = yield* notifyIfFailed(member.threadId, run).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("J5 crew seat finish sweep skipped a seat", {
                  threadId: member.threadId,
                  cause,
                }).pipe(Effect.as(null)),
              ),
            );
            if (outcome !== null) reportedNow.push(outcome);
          }
        }
        if (reportedNow.length > 0)
          yield* Effect.logInfo("J5 crew seat finish sweep reported failed seats", {
            reportedNow,
          });
        return reportedNow;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("J5 crew seat finish sweep failed", { cause }).pipe(Effect.as([])),
        ),
      );

      const handleStoredEvent: CrewSeatFinishNotifierShape["handleStoredEvent"] = Effect.fn(
        "j5.a2a.crewSeatFinish.handleStoredEvent",
      )(
        function* (stored) {
          const run = failedRun(stored);
          if (run === undefined) return null;
          return yield* notifyIfFailed(run.threadId, run);
        },
        Effect.catchCause((cause) =>
          Effect.logWarning("J5 crew seat finish notice skipped", { cause }).pipe(Effect.as(null)),
        ),
      );

      if (daemon) {
        const playbooks = yield* PlaybookCrewRelay;
        // The stream starts from the event store's current high-water mark, so everything that
        // landed while the server was down, and every reaction that failed before it, is caught
        // up by one sweep first: orphaned Crews retire, failed seats tell their Captains.
        const runDaemon = Effect.gen(function* () {
          let afterSequence = yield* readEventStoreHighWater("J5 crew seat finish notifier");
          // Launches the server lost mid-report are reported first, so a first turn that failed
          // while it was down is a launch outcome rather than a finish.
          yield* playbooks.reconcileOwners();
          yield* reporter.reconcile;
          yield* cascade.reconcile;
          yield* reconcile;
          // Suspended so each resume after a stream failure starts from the last handled
          // sequence rather than from the daemon's start.
          return yield* Effect.forever(
            Stream.suspend(() => threads.streamStoredEventsFrom({ afterSequence })).pipe(
              // One stream serves both Crew reactions: seats settling, and a Captain's archive
              // retiring its Crews (CrewCaptainArchiveCascade).
              Stream.runForEach((event) =>
                playbooks.handleOwnerEvent(event).pipe(
                  Effect.andThen(reporter.handleStoredEvent(event)),
                  Effect.andThen(handleStoredEvent(event)),
                  Effect.andThen(cascade.handleStoredEvent(event)),
                  Effect.tap(() => Effect.sync(() => (afterSequence = event.sequence))),
                ),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("J5 crew seat finish stream failed; resuming", {
                  cause,
                }).pipe(Effect.andThen(Effect.sleep(Duration.seconds(1)))),
              ),
            ),
          );
        });
        yield* Effect.forkScoped(runDaemon);
      }

      return CrewSeatFinishNotifier.of({ handleStoredEvent, reconcile });
    }),
  );

export const manualLayer = makeLayer(false).pipe(Layer.provide(sharedThreadsLayer));
export const layer = makeLayer(true).pipe(Layer.provide(sharedThreadsLayer));
