import * as CrewTurnContext from "./CrewTurnContext.ts";
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
  const deliveryLayer = CrewTurnContext.layer;
  const deliver = (text: string, fail = false) =>
    Effect.gen(function* () {
      return yield* (yield* CrewTurnContext.CrewTurnContext).deliver(seatId, text, (prompt) =>
        fail ? Effect.fail("provider refused") : Effect.succeed(prompt),
      );
    }).pipe(Effect.provide(deliveryLayer));
  return { sql, crews, commands, receipts, rejected, layer, send, deliver };
});

it.effect(
  "acceptance leaves context owed; provider delivery includes the current roster and original assignment",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const command = assignment("direct", "user");
      yield* f.send(command).pipe(Effect.provide(f.layer));
      assert.isTrue((yield* f.crews.read("crew:test"))!.members[0]!.notStarted);
      assert.deepStrictEqual((yield* Ref.get(f.commands))[0], command);
      yield* f.crews.addMembers("crew:test", [member("security")]);
      yield* f.crews.removeMembers("crew:test", ["builder"]);
      const prompt = yield* f.deliver(command.text);
      assert.include(prompt, "<spawner_brief>\nShared goal\n</spawner_brief>");
      assert.include(prompt, "Review carefully.");
      assert.include(prompt, "- security:");
      assert.notInclude(prompt, "- builder:");
      assert.isTrue(prompt.endsWith(command.text));
      assert.isFalse((yield* f.crews.read("crew:test"))!.members[0]!.notStarted);
    }).pipe(Effect.provide(base)),
);

it.effect(
  "worktree assignments use durable preparation without storing context in editable text",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sql`UPDATE j5_crew_seat_context SET workspace = '{"type":"worktree","baseRef":"j5/main"}'`;
      const command = assignment("playbook", "system");
      yield* f.send(command).pipe(Effect.provide(f.layer));
      const [delivered] = yield* Ref.get(f.commands);
      if (delivered?.type !== "message.dispatch") return assert.fail("missing assignment");
      assert.deepStrictEqual(delivered.dispatchMode, {
        type: "defer_start",
        workspaceStrategy: { type: "worktree", baseRef: "j5/main" },
      });
      assert.equal(delivered.text, command.text);
    }).pipe(Effect.provide(base)),
);

it.effect("provider refusal keeps the introduction and roster changes owed", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    assert.equal((yield* f.deliver("first", true).pipe(Effect.result))._tag, "Failure");
    assert.include(yield* f.deliver("retry"), "<j5_spawn_context>");
    yield* f.crews.addMembers("crew:test", [member("security")]);
    yield* f.crews.removeMembers("crew:test", ["builder"]);
    yield* f.deliver("refused update", true).pipe(Effect.result);
    const prompt = yield* f.deliver("accepted update");
    assert.include(prompt, "joined: security:");
    assert.include(prompt, "left: builder:");
    assert.notInclude(prompt, "spawner_brief");
    assert.equal(yield* f.deliver("later"), "later");
  }).pipe(Effect.provide(base)),
);

it.effect(
  "queued edits, cancellation and reordering cannot consume or reorder roster changes",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.deliver("first");
      yield* f.crews.addMembers("crew:test", [member("temporary")]);
      yield* f.send(assignment("queued-first")).pipe(Effect.provide(f.layer));
      yield* f.crews.removeMembers("crew:test", ["temporary", "builder"]);
      yield* f.crews.addMembers("crew:test", [member("security")]);
      yield* f.send(assignment("queued-second")).pipe(Effect.provide(f.layer));
      // The provider sees whichever editable message upstream selects, not acceptance order.
      const prompt = yield* f.deliver("edited second assignment promoted first");
      assert.include(prompt, "joined: security:");
      assert.include(prompt, "left: builder:");
      assert.notInclude(prompt, "temporary");
      assert.isTrue(prompt.endsWith("edited second assignment promoted first"));
      assert.equal(yield* f.deliver("remaining assignment"), "remaining assignment");
    }).pipe(Effect.provide(base)),
);

it.effect(
  "an archived waiting seat cannot bypass workspace preparation when independently reopened",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sql`UPDATE j5_crew_seat_context SET workspace = '{"type":"worktree","baseRef":"main"}'`;
      yield* f.crews.markArchived("crew:test", "2026-10-27T13:00:00Z");
      const result = yield* f
        .send(assignment("after-archive"))
        .pipe(Effect.result, Effect.provide(f.layer));
      assert.equal(result._tag, "Failure");
      assert.lengthOf(yield* Ref.get(f.commands), 0);
      assert.equal((yield* f.deliver("bypass", false).pipe(Effect.result))._tag, "Failure");
    }).pipe(Effect.provide(base)),
);

it.effect(
  "a retired started seat still cannot run in the project root after worktree failure",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sql`UPDATE j5_crew_seat_context SET delivered_roster = '[]', workspace = '{"type":"worktree","baseRef":"main"}'`;
      yield* f.crews.markArchived("crew:test", "2026-10-27T13:00:00Z");
      const result = yield* f
        .send(assignment("after-failed-preparation"))
        .pipe(Effect.result, Effect.provide(f.layer));
      assert.equal(result._tag, "Failure");
      assert.lengthOf(yield* Ref.get(f.commands), 0);
    }).pipe(Effect.provide(base)),
);

it.effect(
  "direct human assignments preserve author prefixes without any author write or subscription invalidation",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const authorPrefix = "[Message from Bryant (owner)]\n\n";
      const command = { ...assignment("authored", "user"), text: authorPrefix + "Review the fix." };
      yield* f.sql`INSERT INTO j5_a2a_message_author (thread_id, message_id, person_id, display_name, level, stored_prefix, created_at)
      VALUES (${seatId}, ${command.messageId}, 'human:owner', 'Bryant', 'owner', ${authorPrefix}, '2026-10-27T12:00:00Z')`;
      yield* f.send(command).pipe(Effect.provide(f.layer));
      const prompt = yield* f.deliver(command.text);
      const [author] = yield* f.sql<{
        readonly stored_prefix: string;
      }>`SELECT stored_prefix FROM j5_a2a_message_author WHERE message_id = ${command.messageId}`;
      assert.equal(author!.stored_prefix, authorPrefix);
      assert.isTrue(prompt.endsWith(command.text));
      assert.deepStrictEqual((yield* Ref.get(f.commands))[0], command);
    }).pipe(Effect.provide(base)),
);

it.effect("an accepted command still replays after its waiting Crew retires", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const command = assignment("replay");
    yield* f.send(command).pipe(Effect.provide(f.layer));
    yield* f.crews.markArchived("crew:test", "2026-10-27T13:00:00Z");
    yield* f.send(command).pipe(Effect.provide(f.layer));
    assert.lengthOf(yield* Ref.get(f.commands), 1);
  }).pipe(Effect.provide(base)),
);

it.effect("a retired member that already started continues as a plain agent", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.deliver("first");
    yield* f.crews.markArchived("crew:test", "2026-10-27T13:00:00Z");
    yield* f.send(assignment("after-retirement")).pipe(Effect.provide(f.layer));
    assert.equal(yield* f.deliver("new assignment"), "new assignment");
  }).pipe(Effect.provide(base)),
);
