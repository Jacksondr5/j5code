import {
  MessageId,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import {
  agentHandoffArtifactPath,
  agentHandoffLogicalPath,
} from "../agents/agentPersonaArtifacts.ts";
import { makeAgentPersonaLibrary } from "../agents/agentPersonaLibrary.ts";
import { ArtifactWorkspace } from "../artifacts/ArtifactWorkspace.ts";
import { AgentCrewInstanceService, type AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { lifecycleCommandId, lifecycleId } from "./spawnIds.ts";

/**
 * Crew members settle themselves: when a member's run ends and it owes no reply to anyone, its
 * thread is settled so the roster shows finished seats as done. A later inbound message starts a
 * new run as usual; settlement is a resting state, not a lock. Captains are never auto-settled
 * here because they keep coordinating after their own turns end.
 *
 * A settlement tells the Captain, as measured facts, how the run ended and where the seat's
 * handoff stands. A member whose definition declares an output artifact writes it as its handoff
 * file, the same shared artifact every saved agent produces; the handoff gate
 * (agentHandoffObserver) checks for it and reminds the seat once. The notice carries the file
 * inline when it exists and is short, so a seat finishing is one message to the Captain, not two.
 *
 * Two rules keep the Captain's queue short (Bryant, 2026-09-14). A notice is posted the first time
 * a seat finishes and again only when its facts changed; a finish whose notice would read exactly
 * like the last one is silent, because the seat's own reply already reached the Captain. And a
 * notice that arrives while the Captain's turn is running folds into the seat notice already
 * queued behind that turn, so the Captain absorbs its Crew's news in one turn, not one per seat.
 */
export interface CrewMemberSettlerShape {
  /** Returns the thread id it settled, or null when the event needed no action. */
  readonly handleStoredEvent: (
    event: OrchestrationV2StoredEvent,
  ) => Effect.Effect<ThreadId | null, never>;
}

export class CrewMemberSettler extends Context.Service<CrewMemberSettler, CrewMemberSettlerShape>()(
  "t3/j5/a2a/CrewMemberSettler",
) {}

const SETTLE_SESSION = "j5-crew-settle";
/** Bodies up to this size ride inline in the Captain's notice; longer ones are read on demand. */
export const INLINE_HANDOFF_MAX_CHARS = 4_000;

/**
 * A seat has finished only when its run completed or failed. Interrupted, cancelled, and rolled
 * back runs are terminal to the orchestrator but not finishes for a Crew: `stop_crew` and the
 * person's Stop crew interrupt seats precisely so they can be briefed again, and the definition
 * says nothing settles then (Crews AC21). Treating those as finishes would settle every stopped
 * seat and wake the Captain to react to its own stop.
 */
const finishedRun = (stored: OrchestrationV2StoredEvent): OrchestrationV2Run | undefined => {
  const event = stored.event;
  return event.type === "run.updated" &&
    (event.payload.status === "completed" || event.payload.status === "failed")
    ? event.payload
    : undefined;
};

const NOTICE_OPEN = "<j5_seat_settled>";

/** Each seat's section of a notice or digest: its opening tag through the text before the next. */
export const seatNoticeSections = (text: string): ReadonlyArray<string> =>
  text
    .split(NOTICE_OPEN)
    .slice(1)
    .map((part) => `${NOTICE_OPEN}${part}`.trim());

const sectionSeat = (section: string) => /^seat: (.+)$/m.exec(section)?.[1]?.trim() ?? null;

/** The newest notice the Captain already holds for a seat, delivered or still queued. */
export const latestSeatNotice = (
  captain: OrchestrationV2ThreadProjection,
  seatName: string,
): string | null => {
  const newestFirst = captain.messages
    .filter((message) => message.role === "user")
    .toSorted((a, b) => DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt));
  for (const message of newestFirst) {
    const sections = seatNoticeSections(message.text).filter(
      (section) => sectionSeat(section) === seatName,
    );
    if (sections.length > 0) return sections[sections.length - 1] ?? null;
  }
  return null;
};

/** A seat notice still queued behind the Captain's running turn; a new notice folds into it. */
export const queuedSeatDigest = (captain: OrchestrationV2ThreadProjection) => {
  if (ThreadManagement.latestActiveRun(captain) === undefined) return null;
  for (const run of captain.runs) {
    if (run.status !== "queued") continue;
    const message = captain.messages.find((item) => item.id === run.userMessageId);
    if (message !== undefined && message.text.startsWith(NOTICE_OPEN)) return { run, message };
  }
  return null;
};

/** A seat's body must not be able to end the body block and continue as platform voice. */
const noticeBody = (body: string) => body.replace(/<\/handoff_body>/g, "<\\/handoff_body>");

export type SeatHandoffFact =
  | {
      readonly status: "written";
      readonly kind: string;
      readonly path: string;
      readonly body: string | null;
    }
  | { readonly status: "missing"; readonly kind: string; readonly path: string }
  | { readonly status: "none declared" };

/**
 * The platform-composed notice the Captain receives when a seat settles: measured facts about
 * the run and the handoff, then the handoff body when it exists and is short.
 */
export const seatSettledNoticeText = (input: {
  readonly seatName: string;
  /** Which Crew the seat sits in; a Captain may command several. */
  readonly crewName: string;
  readonly participantId: string;
  readonly threadId: string;
  readonly runStatus: string;
  readonly handoff: SeatHandoffFact;
}) => {
  const handoffLine =
    input.handoff.status === "none declared"
      ? "handoff: none declared"
      : `handoff: ${input.handoff.status} (${input.handoff.kind})\nartifact: ${agentHandoffLogicalPath(input.handoff.path)}`;
  const head = `<j5_seat_settled>\nseat: ${input.seatName}\ncrew: ${input.crewName}\nparticipant_id: ${input.participantId}\nthread_id: ${input.threadId}\nrun_status: ${input.runStatus}\n${handoffLine}\n</j5_seat_settled>`;
  if (input.handoff.status !== "written") return head;
  return input.handoff.body !== null && input.handoff.body.length <= INLINE_HANDOFF_MAX_CHARS
    ? `${head}\n\n<handoff_body>\n${noticeBody(input.handoff.body)}\n</handoff_body>`
    : `${head}\n\nRead it with read_artifact (path: ${input.handoff.path}).`;
};

const makeLayer = (daemon: boolean) =>
  Layer.effect(
    CrewMemberSettler,
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const crews = yield* AgentCrewInstanceService;
      const workspace = yield* ArtifactWorkspace;
      const agents = yield* makeAgentPersonaLibrary;
      const sql = yield* SqlClient.SqlClient;

      const owedReplies = Effect.fn("j5.a2a.crewSettler.owedReplies")(function* (
        participantId: string,
      ) {
        const rows = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM j5_a2a_exchange
          WHERE status = 'open' AND receiver_id = ${participantId}
        `;
        return Number(rows[0]?.count ?? 0);
      });

      /** Where the seat's declared handoff stands: the file itself is the fact, not the store. */
      const handoffFact = Effect.fn("j5.a2a.crewSettler.handoffFact")(function* (
        projection: OrchestrationV2ThreadProjection,
        kind: string | null,
      ): Effect.fn.Return<SeatHandoffFact, never, never> {
        const assignment = projection.thread.agentPersonaAssignment;
        if (kind === null || assignment === undefined) return { status: "none declared" } as const;
        const path = agentHandoffArtifactPath({
          personaId: assignment.personaId,
          artifact: kind,
          threadId: projection.thread.id,
        });
        const projectId = projection.thread.projectId;
        // One read answers both questions; listing the whole artifacts tree to check for a single
        // known path is a full directory walk on every seat finish.
        const content = yield* Effect.result(workspace.read({ projectId, relativePath: path }));
        if (Result.isFailure(content)) {
          if (content.failure.reason !== "not_found") {
            yield* Effect.logWarning("J5 crew settler could not read a seat handoff", {
              path,
              cause: content.failure,
            });
          }
          return { status: "missing", kind, path };
        }
        return {
          status: "written",
          kind,
          path,
          body: content.success.encoding === "utf8" ? content.success.content : null,
        } as const;
      });

      /**
       * Tells the Captain what changed. Ids derive from the run, so a redelivered event cannot
       * post twice; a fold checks the digest for the same text for the same reason.
       */
      const notifyCaptain = Effect.fn("j5.a2a.crewSettler.notifyCaptain")(function* (
        instance: AgentCrewInstance,
        seatName: string,
        projection: OrchestrationV2ThreadProjection,
        run: OrchestrationV2Run,
        handoff: SeatHandoffFact,
      ) {
        const threadId = projection.thread.id;
        const captain = yield* threads.getThreadProjection(instance.captainThreadId);
        const stable = { providerSessionId: SETTLE_SESSION, requestKey: `${threadId}:${run.id}` };
        const text = seatSettledNoticeText({
          seatName,
          crewName: instance.displayName,
          participantId: participantIdForThread(threadId),
          threadId,
          runStatus: run.status,
          handoff,
        });
        if (latestSeatNotice(captain, seatName) === text.trim()) return "unchanged" as const;
        const digest = queuedSeatDigest(captain);
        if (digest !== null) {
          if (!digest.message.text.includes(text)) {
            yield* threads.dispatch({
              type: "queued-run.edit",
              commandId: lifecycleCommandId({ ...stable, operation: "seat-settled-fold" }),
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
          commandId: lifecycleCommandId({ ...stable, operation: "seat-settled" }),
          threadId: instance.captainThreadId,
          messageId: MessageId.make(
            lifecycleId({ ...stable, kind: "message", operation: "seat-settled" }),
          ),
          text,
          attachments: [],
          modelSelection: captain.thread.modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        return "posted" as const;
      });

      const settleIfFinished = Effect.fn("j5.a2a.crewSettler.settleIfFinished")(function* (
        threadId: ThreadId,
        run: OrchestrationV2Run,
      ) {
        const participantId = participantIdForThread(threadId);
        const membership = yield* crews.findMembership(participantId);
        if (membership === null) return null;
        const instance = yield* crews.read(membership.crewInstanceId);
        if (instance === null || instance.archivedAt !== null) return null;
        const projection = yield* threads.getThreadProjection(threadId);
        if (projection.thread.archivedAt !== null || projection.thread.settledOverride !== null)
          return null;
        if (ThreadManagement.latestActiveRun(projection) !== undefined) return null;
        if ((yield* owedReplies(participantId)) > 0) return null;
        // What the seat owes comes from its immutable snapshot, not today's library. A snapshot
        // that cannot be read leaves the seat unsettled and logged rather than quietly finished.
        const assignment = projection.thread.agentPersonaAssignment;
        const owedKind =
          assignment === undefined
            ? null
            : ((yield* agents.readSnapshot(assignment)).outputArtifact ?? null);
        const handoff = yield* handoffFact(projection, owedKind);
        yield* notifyCaptain(instance, membership.seatName, projection, run, handoff).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("J5 crew seat-settled notice skipped", { cause, threadId }),
          ),
        );
        yield* threads.dispatch({
          type: "thread.settle",
          commandId: lifecycleCommandId({
            providerSessionId: SETTLE_SESSION,
            requestKey: `${threadId}:${run.id}`,
            operation: "crew-member-settle",
          }),
          threadId,
          settledAt: yield* DateTime.now,
        });
        return threadId;
      });

      const handleStoredEvent: CrewMemberSettlerShape["handleStoredEvent"] = (stored) =>
        Effect.gen(function* () {
          const run = finishedRun(stored);
          if (run === undefined) return null;
          return yield* settleIfFinished(run.threadId, run);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("J5 crew member settlement skipped", { cause }).pipe(Effect.as(null)),
          ),
        );

      if (daemon) {
        // Start from the current high-water mark: a missed settle is harmless and the next
        // terminal run for that member catches up.
        const runDaemon = Effect.gen(function* () {
          const rows = yield* sql<{ readonly sequence: number }>`
            SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_v2_events
          `;
          let afterSequence = rows[0]?.sequence ?? 0;
          // Suspended so each resume after a stream failure starts from the last handled
          // sequence rather than from the daemon's start.
          return yield* Effect.forever(
            Stream.suspend(() => threads.streamStoredEventsFrom({ afterSequence })).pipe(
              Stream.runForEach((event) =>
                handleStoredEvent(event).pipe(
                  Effect.tap(() => Effect.sync(() => (afterSequence = event.sequence))),
                ),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("J5 crew member settlement stream failed; resuming", {
                  cause,
                }).pipe(Effect.andThen(Effect.sleep(Duration.seconds(1)))),
              ),
            ),
          );
        });
        yield* Effect.forkScoped(runDaemon);
      }

      return CrewMemberSettler.of({ handleStoredEvent });
    }),
  );

export const manualLayer = makeLayer(false);
export const layer = makeLayer(true);
