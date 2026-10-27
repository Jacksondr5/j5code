import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ThreadId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import {
  CommandReceiptStoreV2,
  type CommandReceiptV2,
} from "../../orchestration-v2/CommandReceiptStore.ts";
import * as Crews from "./AgentCrewInstanceService.ts";
import * as DeliveryContext from "./CrewDeliveryContext.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { LedgerProjectId } from "./contracts.ts";
import { spawnFirstTurnText } from "./spawnIds.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const base = Layer.mergeAll(
  database,
  Crews.layer.pipe(Layer.provide(database)),
  ledgerLayer.pipe(Layer.provide(database)),
);
const seatId = ThreadId.make("thread:reviewer");
const captainThreadId = ThreadId.make("thread:captain");
const projectId = LedgerProjectId.make("project:crew-context");
const member = (name: string) => ({
  seatName: name,
  agentId: null,
  threadId: ThreadId.make(`thread:${name}`),
  participantId: participantIdForThread(ThreadId.make(`thread:${name}`)),
  reason: `Responsibility of ${name}`,
});
const assignment = (id: string, createdBy: "user" | "agent" | "system" = "agent") => ({
  type: "message.dispatch" as const,
  commandId: CommandId.make(`command:${id}`),
  threadId: seatId,
  messageId: MessageId.make(`message:${id}`),
  text: `<message_envelope>\nassignment ${id}\nreply_to: sender\n</message_envelope>`,
  senderThreadId: captainThreadId,
  attachments: [],
  dispatchMode: { type: "start_immediately" as const },
  createdBy,
  creationSource: "mcp" as const,
});
const fixture = Effect.gen(function* () {
  yield* runJ5A2AMigrations();
  const sql = yield* SqlClient.SqlClient;
  const crews = yield* Crews.AgentCrewInstanceService;
  const createdAt = "2026-10-27T12:00:00.000Z";
  yield* (yield* A2ALedger).ensureProject({ projectId, createdAt });
  yield* crews.record({
    id: "crew:test",
    projectId,
    captainThreadId,
    captainParticipantId: participantIdForThread(captainThreadId),
    displayName: "Test crew",
    brief: "Shared goal",
    createdAt,
    members: [member("reviewer"), member("builder")],
  });
  const firstTurnText = spawnFirstTurnText({
    brief: "Shared goal",
    participantId: participantIdForThread(seatId),
    projectId,
    projectTitle: "Test",
    spawnedByParticipantId: participantIdForThread(captainThreadId),
    spawnerThreadId: captainThreadId,
    crew: {
      displayName: "Test crew",
      instanceId: "crew:test",
      seatName: "reviewer",
      captainParticipantId: participantIdForThread(captainThreadId),
      roster: [],
      seatInstructions: "Review carefully.",
    },
  });
  yield* sql`INSERT INTO j5_crew_seat_context (thread_id, first_turn_text, workspace)
    VALUES (${seatId}, ${firstTurnText}, '{"type":"shared"}')`;
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const receipts = new Map<string, CommandReceiptV2>();
  const rejected = new Set<string>();
  const dependencies = Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: () => Effect.succeed({ worktreePath: null } as never),
      getThreadRecords: () => Effect.succeed({ runs: [] } as never),
      dispatch: (command) =>
        Effect.gen(function* () {
          if (receipts.has(command.commandId)) return { sequence: 1, storedEvents: [] };
          if (rejected.has(command.commandId))
            return yield* new Orchestrator.OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
            });
          yield* Ref.update(commands, (all) => [...all, command]);
          receipts.set(command.commandId, { status: "accepted" } as CommandReceiptV2);
          return { sequence: 1, storedEvents: [] };
        }),
    }),
    Layer.mock(CommandReceiptStoreV2)({
      getByCommandId: (id) => Effect.succeed(Option.fromNullishOr(receipts.get(id))),
    }),
  );
  const layer = DeliveryContext.layer.pipe(Layer.provide(dependencies));
  const send = (command: OrchestrationV2ServerCommand) =>
    Effect.gen(function* () {
      return yield* (yield* Orchestrator.OrchestratorV2).dispatch(command);
    });
  return { sql, crews, commands, receipts, rejected, layer, send };
});

it.effect(
  "a direct user message starts a seat with its approved brief, current roster and intact envelope",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.crews.addMembers("crew:test", [member("security")]);
      yield* f.crews.removeMembers("crew:test", ["builder"]);
      const command = assignment("direct", "user");
      yield* f.send(command).pipe(Effect.provide(f.layer));
      const [delivered] = yield* Ref.get(f.commands);
      assert.equal(delivered?.type, "message.dispatch");
      if (delivered?.type !== "message.dispatch") return;
      assert.include(delivered.text, "<spawner_brief>\nShared goal\n</spawner_brief>");
      assert.include(delivered.text, "Review carefully.");
      assert.include(
        delivered.text,
        `- security: participant_id=${member("security").participantId} persona=custom responsibility=Responsibility of security`,
      );
      assert.notInclude(delivered.text, "- builder:");
      assert.notInclude(delivered.text, "<j5_crew_roster_changed>");
      assert.isTrue(delivered.text.endsWith(command.text));
      assert.equal(delivered.messageId, command.messageId);
      assert.equal(delivered.senderThreadId, command.senderThreadId);
      assert.equal(delivered.createdBy, "user");
      assert.isFalse((yield* f.crews.read("crew:test"))!.members[0]!.notStarted);
    }).pipe(Effect.provide(base)),
);

it.effect("playbook deliveries activate a new-worktree seat through durable preparation", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.sql`UPDATE j5_crew_seat_context SET workspace = '{"type":"worktree","baseRef":"j5/main"}'`;
    yield* f
      .send({ ...assignment("playbook", "system"), text: "<j5_playbook_step>\nDo the review" })
      .pipe(Effect.provide(f.layer));
    const [delivered] = yield* Ref.get(f.commands);
    if (delivered?.type !== "message.dispatch") return assert.fail("missing assignment");
    assert.deepStrictEqual(delivered.dispatchMode, {
      type: "defer_start",
      workspaceStrategy: { type: "worktree", baseRef: "j5/main" },
    });
    assert.include(delivered.text, "Shared goal");
    assert.isTrue(delivered.text.endsWith("<j5_playbook_step>\nDo the review"));
  }).pipe(Effect.provide(base)),
);

it.effect("finished members get only their next assignment and net roster changes, once", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      yield* f.send(assignment("first"));
      yield* f.crews.addMembers("crew:test", [member("temporary")]);
      yield* f.crews.removeMembers("crew:test", ["temporary", "builder"]);
      yield* f.crews.addMembers("crew:test", [member("security")]);
      assert.lengthOf(yield* Ref.get(f.commands), 1);
      yield* f.send(assignment("second"));
      yield* f.send(assignment("third"));
      yield* f.send(assignment("third"));
    }).pipe(Effect.provide(f.layer));
    const delivered = (yield* Ref.get(f.commands)).filter(
      (command) => command.type === "message.dispatch",
    );
    assert.lengthOf(delivered, 3);
    assert.isTrue(
      delivered[1]!.text.startsWith("<j5_crew_delivery_context>\n<j5_crew_roster_changed>"),
    );
    assert.include(delivered[1]!.text, "joined: security:");
    assert.include(delivered[1]!.text, "left: builder:");
    assert.notInclude(delivered[1]!.text, "temporary");
    assert.notInclude(delivered[1]!.text, "spawner_brief");
    assert.equal(delivered[2]!.text, assignment("third").text);
  }).pipe(Effect.provide(base)),
);

it.effect("concurrent first assignments introduce a seat only once", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.all([f.send(assignment("one")), f.send(assignment("two"))], {
      concurrency: "unbounded",
    }).pipe(Effect.provide(f.layer));
    const commands = (yield* Ref.get(f.commands)).filter(
      (command) => command.type === "message.dispatch",
    );
    assert.lengthOf(
      commands.filter((command) => command.text.includes("<j5_spawn_context>")),
      1,
    );
    assert.lengthOf(commands, 2);
  }).pipe(Effect.provide(base)),
);

it.effect("a rejected assignment leaves the introduction owed to the next assignment", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.rejected.add("command:refused");
    yield* Effect.gen(function* () {
      yield* f.send(assignment("refused")).pipe(Effect.result);
      yield* f.crews.addMembers("crew:test", [member("security")]);
      yield* f.send(assignment("accepted"));
    }).pipe(Effect.provide(f.layer));
    const [delivered] = yield* Ref.get(f.commands);
    if (delivered?.type !== "message.dispatch") return assert.fail("missing assignment");
    assert.include(delivered.text, "<j5_spawn_context>");
    assert.include(delivered.text, "- security:");
  }).pipe(Effect.provide(base)),
);

it.effect(
  "a committed first assignment is recovered after a crash without repeating its introduction",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      // Simulate the cut between the orchestration commit and J5's delivered-roster write.
      yield* f.sql`UPDATE j5_crew_seat_context SET pending_command_id = 'command:first', pending_roster = '[]'`;
      f.receipts.set("command:first", { status: "accepted" } as CommandReceiptV2);
      yield* f.send(assignment("later")).pipe(Effect.provide(f.layer));
      const [delivered] = yield* Ref.get(f.commands);
      if (delivered?.type !== "message.dispatch") return assert.fail("missing assignment");
      assert.notInclude(delivered.text, "<j5_spawn_context>");
      assert.include(delivered.text, "<j5_crew_roster_changed>");
    }).pipe(Effect.provide(base)),
);

it.effect(
  "follow-up work is refused after a worktree preparation failed instead of running in the project root",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sql`UPDATE j5_crew_seat_context SET delivered_roster = '[]', workspace = '{"type":"worktree","baseRef":"main"}'`;
      const result = yield* f
        .send(assignment("after-failed-preparation"))
        .pipe(Effect.result, Effect.provide(f.layer));
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure")
        assert.include(result.failure.message, "Retry workspace preparation");
      assert.lengthOf(yield* Ref.get(f.commands), 0);
    }).pipe(Effect.provide(base)),
);

it.effect(
  "direct human assignments keep their author attribution and displayed words after activation and replay",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const authorPrefix = "[Message from Bryant (owner)]\n\n";
      const command = { ...assignment("authored", "user"), text: authorPrefix + "Review the fix." };
      yield* f.sql`INSERT INTO j5_a2a_message_author
      (thread_id, message_id, person_id, display_name, level, stored_prefix, created_at)
      VALUES (${seatId}, ${command.messageId}, 'human:owner', 'Bryant', 'owner', ${authorPrefix}, '2026-10-27T12:00:00Z')`;
      yield* Effect.gen(function* () {
        yield* f.send(command);
        yield* f.send(command);
      }).pipe(Effect.provide(f.layer));
      const [author] = yield* f.sql<{ readonly stored_prefix: string; readonly person_id: string }>`
      SELECT stored_prefix, person_id FROM j5_a2a_message_author WHERE message_id = ${command.messageId}
    `;
      const [delivered] = yield* Ref.get(f.commands);
      if (delivered?.type !== "message.dispatch") return assert.fail("missing assignment");
      assert.equal(author!.person_id, "human:owner");
      assert.isTrue(delivered.text.startsWith(author!.stored_prefix));
      assert.equal(delivered.text.slice(author!.stored_prefix.length), "Review the fix.");
      assert.lengthOf(yield* Ref.get(f.commands), 1);
    }).pipe(Effect.provide(base)),
);
