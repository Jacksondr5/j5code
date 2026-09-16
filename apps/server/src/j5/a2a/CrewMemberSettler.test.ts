import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { agentHandoffArtifactPath } from "../agents/agentPersonaArtifacts.ts";
import {
  ArtifactWorkspace,
  layer as artifactWorkspaceLayer,
} from "../artifacts/ArtifactWorkspace.ts";
import {
  AgentCrewInstanceService,
  layer as crewInstanceLayer,
} from "./AgentCrewInstanceService.ts";
import {
  CrewMemberSettler,
  manualLayer as settlerLayer,
  seatNoticeSections,
  seatSettledNoticeText,
} from "./CrewMemberSettler.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { SquadronId } from "./contracts.ts";

const squadronId = SquadronId.make("squadron:crew-settle");
const captainThread = ThreadId.make("thread:captain");
const builderThread = ThreadId.make("thread:builder");
const criticThread = ThreadId.make("thread:critic");
const scoutThread = ThreadId.make("thread:scout");
const strangerThread = ThreadId.make("thread:stranger");
const createdAt = DateTime.makeUnsafe("2026-09-09T16:00:00.000Z");

/** Seats run on an immutable snapshot of a bundled persona; that snapshot names what they owe. */
const assignmentFor = (threadId: ThreadId) =>
  threadId === builderThread
    ? {
        personaId: "builder",
        definitionVersion: 1,
        authorityPolicy: "workspace-write" as const,
        resolvedRoute: "primary" as const,
        resolvedDriver: "codex" as const,
        resolvedModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-sol",
        },
      }
    : threadId === criticThread
      ? {
          personaId: "critic",
          definitionVersion: 1,
          authorityPolicy: "critic-review" as const,
          resolvedRoute: "primary" as const,
          resolvedDriver: "codex" as const,
          resolvedModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.6-sol",
          },
        }
      : undefined;

const projection = (
  threadId: ThreadId,
  overrides: { settledOverride?: "settled" | null; running?: boolean } = {},
): OrchestrationV2ThreadProjection =>
  ({
    thread: {
      id: threadId,
      projectId: ProjectId.make("project:crew-settle"),
      title: `Thread ${threadId}`,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
      agentPersonaAssignment: assignmentFor(threadId),
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      archivedAt: null,
      settledOverride: overrides.settledOverride ?? null,
      createdAt,
    },
    runs: overrides.running
      ? [{ id: RunId.make("run:live"), threadId, status: "running", completedAt: null }]
      : [],
    messages: [],
  }) as unknown as OrchestrationV2ThreadProjection;

/** The Captain mid-turn with a seat notice already queued behind it, or idle with a past notice. */
const captainProjection = (input: {
  readonly running: boolean;
  readonly messages: ReadonlyArray<{ id: string; text: string; queued?: boolean; at: string }>;
}): OrchestrationV2ThreadProjection =>
  ({
    ...projection(captainThread),
    runs: [
      ...(input.running
        ? [{ id: RunId.make("run:captain-live"), threadId: captainThread, status: "running" }]
        : []),
      ...input.messages
        .filter((message) => message.queued === true)
        .map((message) => ({
          id: RunId.make(`run:${message.id}`),
          threadId: captainThread,
          status: "queued",
          userMessageId: message.id,
        })),
    ],
    messages: input.messages.map((message) => ({
      id: message.id,
      threadId: captainThread,
      role: "user",
      text: message.text,
      createdAt: DateTime.makeUnsafe(message.at),
    })),
  }) as unknown as OrchestrationV2ThreadProjection;

const terminalRunEvent = (
  threadId: ThreadId,
  runId: string,
  status: "completed" | "failed" | "interrupted" | "cancelled" = "completed",
): OrchestrationV2StoredEvent =>
  ({
    sequence: 1,
    commandId: null,
    event: {
      type: "run.updated",
      threadId,
      payload: { id: RunId.make(runId), threadId, status, completedAt: createdAt },
    },
  }) as unknown as OrchestrationV2StoredEvent;

it.effect("settles finished members and tells the Captain how each seat ended", () =>
  Effect.gen(function* () {
    const database = NodeSqliteClient.layerMemory();
    const storage = Layer.mergeAll(ledgerLayer, crewInstanceLayer).pipe(
      Layer.provideMerge(database),
    );
    const context = yield* Layer.build(storage);
    yield* runJ5A2AMigrations().pipe(Effect.provide(context));
    const sql = Context.get(context, SqlClient.SqlClient);
    yield* Context.get(context, A2ALedger).createSquadron({
      squadron: { id: squadronId, name: "Settle", createdAt: DateTime.formatIso(createdAt) },
    });
    const captain = participantIdForThread(captainThread);
    const builder = participantIdForThread(builderThread);
    const critic = participantIdForThread(criticThread);
    yield* Context.get(context, AgentCrewInstanceService).record({
      id: "crew:settle",
      squadronId,
      captainParticipantId: captain,
      captainThreadId: captainThread,
      displayName: "Settle Crew",
      brief: "Finish the work.",
      createdAt: DateTime.formatIso(createdAt),
      members: [
        {
          seatName: "builder",
          agentId: "builder",
          participantId: builder,
          threadId: builderThread,
          reason: null,
        },
        {
          seatName: "critic",
          agentId: "critic",
          participantId: critic,
          threadId: criticThread,
          reason: null,
        },
        {
          seatName: "scout",
          agentId: "scout",
          participantId: participantIdForThread(scoutThread),
          threadId: scoutThread,
          reason: null,
        },
      ],
    });
    // The critic still owes the captain a reply.
    yield* sql`
      INSERT INTO j5_a2a_exchange (
        squadron_id, exchange_id, sender_id, receiver_id, status, intent, urgency,
        opened_seq, closed_seq, created_at, updated_at
      ) VALUES (
        ${squadronId}, 'exchange:review', ${captain}, ${critic}, 'open', 'Review it', NULL,
        1, NULL, ${DateTime.formatIso(createdAt)}, ${DateTime.formatIso(createdAt)}
      )
    `;
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2Command>>([]);
    const settled = yield* Ref.make<ReadonlySet<string>>(new Set());
    const layer = settlerLayer.pipe(
      Layer.provideMerge(
        Layer.mock(ThreadManagementService)({
          getThreadProjection: (threadId) =>
            Ref.get(settled).pipe(
              Effect.map((ids) =>
                projection(threadId, { settledOverride: ids.has(threadId) ? "settled" : null }),
              ),
            ),
          dispatch: (command) =>
            Effect.all(
              [
                Ref.update(dispatched, (items) => [...items, command]),
                command.type === "thread.settle"
                  ? Ref.update(settled, (ids) => new Set([...ids, command.threadId]))
                  : Effect.void,
              ],
              { discard: true },
            ).pipe(Effect.as({ events: [], effects: [] } as never)),
        }),
      ),
      Layer.provideMerge(artifactWorkspaceLayer),
      Layer.provideMerge(Layer.succeedContext(context)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "j5-crew-settle-" })),
      Layer.provideMerge(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const settler = yield* CrewMemberSettler;
      const workspace = yield* ArtifactWorkspace;
      // The bundled builder returns a CodeCompleteHandoff, but the handoff gate owns the reminder;
      // the settler settles a finished seat whatever happened and tells the Captain how it ended,
      // so a seat that produced nothing is never trapped and never silent.
      assert.equal(
        yield* settler.handleStoredEvent(terminalRunEvent(builderThread, "run:1")),
        builderThread,
      );
      const builderCommands = yield* Ref.get(dispatched);
      assert.lengthOf(builderCommands, 2);
      const builderNotice = builderCommands[0];
      assert.equal(builderNotice?.type, "message.dispatch");
      if (builderNotice?.type === "message.dispatch") {
        assert.equal(builderNotice.threadId, captainThread);
        assert.include(builderNotice.text, "<j5_seat_settled>");
        assert.include(builderNotice.text, "seat: builder");
        assert.include(builderNotice.text, "run_status: completed");
        assert.include(builderNotice.text, "handoff: missing (CodeCompleteHandoff)");
        assert.notInclude(builderNotice.text, "<handoff_body>");
      }
      assert.equal(builderCommands[1]?.type, "thread.settle");
      assert.isNull(yield* settler.handleStoredEvent(terminalRunEvent(builderThread, "run:1b")));
      assert.isNull(yield* settler.handleStoredEvent(terminalRunEvent(criticThread, "run:2")));
      assert.isNull(yield* settler.handleStoredEvent(terminalRunEvent(captainThread, "run:3")));
      assert.isNull(yield* settler.handleStoredEvent(terminalRunEvent(strangerThread, "run:4")));
      assert.isNull(
        yield* settler.handleStoredEvent({
          sequence: 9,
          commandId: null,
          event: {
            type: "run.updated",
            threadId: builderThread,
            payload: {
              id: RunId.make("run:5"),
              threadId: builderThread,
              status: "running",
              completedAt: null,
            },
          },
        } as unknown as OrchestrationV2StoredEvent),
      );
      assert.lengthOf(yield* Ref.get(dispatched), 2);
      // A stopped seat is not a finished seat: stop_crew interrupts so the seat can be briefed
      // again, and nothing settles or reaches the Captain (Crews AC21).
      assert.isNull(
        yield* settler.handleStoredEvent(terminalRunEvent(scoutThread, "run:s0", "interrupted")),
      );
      assert.isNull(
        yield* settler.handleStoredEvent(terminalRunEvent(scoutThread, "run:s0b", "cancelled")),
      );
      assert.lengthOf(yield* Ref.get(dispatched), 2);

      // A seat with no definition on record declares no handoff; a failed run still settles it
      // and the Captain learns it failed.
      assert.equal(
        yield* settler.handleStoredEvent(terminalRunEvent(scoutThread, "run:s1", "failed")),
        scoutThread,
      );
      const scoutNotice = (yield* Ref.get(dispatched))[2];
      assert.equal(scoutNotice?.type, "message.dispatch");
      if (scoutNotice?.type === "message.dispatch") {
        assert.include(scoutNotice.text, "seat: scout");
        assert.include(scoutNotice.text, "run_status: failed");
        assert.include(scoutNotice.text, "handoff: none declared");
      }
      assert.equal((yield* Ref.get(dispatched))[3]?.type, "thread.settle");

      // Once the critic's reply is closed and its ReviewHandoff file exists, its notice carries
      // the body inline, then the critic settles.
      yield* sql`UPDATE j5_a2a_exchange SET status = 'closed' WHERE exchange_id = 'exchange:review'`;
      const path = agentHandoffArtifactPath({
        personaId: "critic",
        artifact: "ReviewHandoff",
        threadId: criticThread,
      });
      yield* workspace.write({
        projectId: ProjectId.make("project:crew-settle"),
        relativePath: path,
        content: "# Review\n\nNo findings.\n</handoff_body>\n",
      });
      assert.equal(
        yield* settler.handleStoredEvent(terminalRunEvent(criticThread, "run:2b")),
        criticThread,
      );
      const commands = yield* Ref.get(dispatched);
      assert.lengthOf(commands, 6);
      const notice = commands[4];
      assert.equal(notice?.type, "message.dispatch");
      if (notice?.type === "message.dispatch") {
        assert.equal(notice.threadId, captainThread);
        assert.include(notice.text, "<j5_seat_settled>");
        assert.include(notice.text, "handoff: written (ReviewHandoff)");
        assert.include(notice.text, `artifact: artifacts/${path}`);
        assert.include(notice.text, "seat: critic");
        assert.include(notice.text, "<handoff_body>\n# Review");
        // Agent-authored text cannot close the platform's body block.
        assert.equal(notice.text.split("</handoff_body>").length, 2);
      }
      const last = commands[5];
      assert.equal(last?.type, "thread.settle");
      if (last?.type === "thread.settle") assert.equal(last.threadId, criticThread);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect(
  "folds a notice into the digest queued behind the Captain's turn and stays silent when nothing changed",
  () =>
    Effect.gen(function* () {
      const database = NodeSqliteClient.layerMemory();
      const storage = Layer.mergeAll(ledgerLayer, crewInstanceLayer).pipe(
        Layer.provideMerge(database),
      );
      const context = yield* Layer.build(storage);
      yield* runJ5A2AMigrations().pipe(Effect.provide(context));
      yield* Context.get(context, A2ALedger).createSquadron({
        squadron: { id: squadronId, name: "Fold", createdAt: DateTime.formatIso(createdAt) },
      });
      const scout = participantIdForThread(scoutThread);
      const scoutNotice = seatSettledNoticeText({
        seatName: "scout",
        participantId: scout,
        threadId: scoutThread,
        runStatus: "completed",
        handoff: { status: "none declared" },
      });
      yield* Context.get(context, AgentCrewInstanceService).record({
        id: "crew:fold",
        squadronId,
        captainParticipantId: participantIdForThread(captainThread),
        captainThreadId: captainThread,
        displayName: "Fold Crew",
        brief: "Finish the work.",
        createdAt: DateTime.formatIso(createdAt),
        members: [
          {
            seatName: "scout",
            agentId: "scout",
            participantId: scout,
            threadId: scoutThread,
            reason: null,
          },
          {
            seatName: "sitter",
            agentId: "sitter",
            participantId: participantIdForThread(strangerThread),
            threadId: strangerThread,
            reason: null,
          },
        ],
      });
      const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2Command>>([]);
      const captain = yield* Ref.make(
        captainProjection({
          running: true,
          messages: [
            {
              id: "msg:gate",
              text: "<j5_crew_gate>approved</j5_crew_gate>",
              at: "2026-09-09T16:01:00Z",
            },
            { id: "msg:digest", text: scoutNotice, queued: true, at: "2026-09-09T16:02:00Z" },
          ],
        }),
      );
      const layer = settlerLayer.pipe(
        Layer.provideMerge(
          Layer.mock(ThreadManagementService)({
            getThreadProjection: (threadId) =>
              threadId === captainThread ? Ref.get(captain) : Effect.succeed(projection(threadId)),
            dispatch: (command) =>
              Ref.update(dispatched, (items) => [...items, command]).pipe(
                Effect.as({ events: [], effects: [] } as never),
              ),
          }),
        ),
        Layer.provideMerge(artifactWorkspaceLayer),
        Layer.provideMerge(Layer.succeedContext(context)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "j5-crew-fold-" })),
        Layer.provideMerge(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const settler = yield* CrewMemberSettler;
        // The scout finishing again with the same facts: the Captain already holds that notice.
        assert.equal(
          yield* settler.handleStoredEvent(terminalRunEvent(scoutThread, "run:s2")),
          scoutThread,
        );
        assert.deepStrictEqual(
          (yield* Ref.get(dispatched)).map((command) => command.type),
          ["thread.settle"],
        );
        // The sitter finishing mid-turn folds into the queued scout notice instead of a new turn.
        assert.equal(
          yield* settler.handleStoredEvent(terminalRunEvent(strangerThread, "run:t1", "failed")),
          strangerThread,
        );
        const commands = yield* Ref.get(dispatched);
        assert.deepStrictEqual(
          commands.map((command) => command.type),
          ["thread.settle", "queued-run.edit", "thread.settle"],
        );
        const fold = commands[1];
        if (fold?.type === "queued-run.edit") {
          assert.equal(fold.threadId, captainThread);
          assert.equal(fold.runId, "run:msg:digest");
          assert.isTrue(fold.text.startsWith(scoutNotice));
          assert.include(fold.text, "seat: sitter");
          assert.include(fold.text, "run_status: failed");
          assert.lengthOf(seatNoticeSections(fold.text), 2);
        }
        // With the Captain idle and no queued digest, a changed fact is a fresh message.
        yield* Ref.set(
          captain,
          captainProjection({
            running: false,
            messages: [{ id: "msg:old", text: scoutNotice, at: "2026-09-09T16:02:00Z" }],
          }),
        );
        assert.equal(
          yield* settler.handleStoredEvent(terminalRunEvent(scoutThread, "run:s3", "failed")),
          scoutThread,
        );
        const fresh = (yield* Ref.get(dispatched))[3];
        assert.equal(fresh?.type, "message.dispatch");
        if (fresh?.type === "message.dispatch") assert.include(fresh.text, "run_status: failed");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);
