import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2SearchThreadsInput,
} from "@t3tools/contracts";
import { LEVEL_PERMISSIONS } from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadSearch from "../../orchestration-v2/ThreadSearch.ts";
import { connectionView } from "./GuestView.ts";
import { accessLayer, device, person } from "./test-support/accessHarness.ts";

/** Cmd+K's message search through a connection's view, as `ws.ts` runs it, over real data. */

const layer = Layer.mergeAll(ThreadSearch.layer, ProjectionStore.layer, ProjectStore.layer).pipe(
  Layer.provideMerge(accessLayer),
);

const providerInstanceId = ProviderInstanceId.make("codex");
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 31, 0, minute));
const SHARED = ProjectId.make("project:search-shared");
const PRIVATE = ProjectId.make("project:search-private");

const createProject = (projectId: ProjectId) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`created:${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: DateTime.formatIso(at(0)),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: projectId,
        workspaceRoot: `/work/${projectId}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: DateTime.formatIso(at(0)),
        updatedAt: DateTime.formatIso(at(0)),
      },
    }),
  );

const thread = (
  threadId: ThreadId,
  projectId: ProjectId,
  settledAt: DateTime.Utc | null = null,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`created:${threadId}`),
  type: "thread.created",
  threadId,
  providerInstanceId,
  occurredAt: at(0),
  payload: {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: threadId,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    linkedPullRequest: null,
    branchPullRequest: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: at(0),
    updatedAt: at(0),
    archivedAt: null,
    settledOverride: settledAt === null ? null : "settled",
    settledAt,
    lastVisitedAt: null,
    deletedAt: null,
  },
});

const message = (
  threadId: ThreadId,
  id: string,
  text: string,
  minute = 1,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`message:${id}`),
  type: "message.updated",
  threadId,
  providerInstanceId,
  occurredAt: at(minute),
  payload: {
    createdBy: "user",
    creationSource: "web",
    id: MessageId.make(id),
    threadId,
    runId: null,
    nodeId: null,
    role: "user",
    text,
    attachments: [],
    streaming: false,
    createdAt: at(minute),
    updatedAt: at(minute),
  },
});

/** Both projects, once per database, then the events; each test seeds what it reads. */
const seed = Effect.fn("test.seed")(function* (events: ReadonlyArray<OrchestrationV2DomainEvent>) {
  const sql = yield* SqlClient.SqlClient;
  for (const projectId of [SHARED, PRIVATE]) {
    const found = yield* sql`SELECT 1 FROM projection_projects WHERE project_id = ${projectId}`;
    if (found.length === 0) yield* createProject(projectId);
  }
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  yield* Effect.forEach(events, projections.apply, { discard: true });
});

/** A device for someone holding these levels, as the server issues one. */
const deviceOf = Effect.fn("test.deviceOf")(function* (
  name: string,
  levels: Parameters<typeof person>[1],
) {
  const created = yield* person(name, levels);
  return (yield* device(created.personId, LEVEL_PERMISSIONS.viewer)).identity;
});

const OWNER = { sessionId: "session:search-owner", subject: "administrative-bootstrap" } as never;

/**
 * The search `ws.ts` runs, through the connection's view. Older settled rows are never read in
 * these tests, and `queries` counts each time upstream's search runs.
 */
const searchAs = Effect.fn("test.searchAs")(function* (
  session: Parameters<typeof connectionView>[0],
  input: OrchestrationV2SearchThreadsInput,
  queries?: Ref.Ref<number>,
) {
  const view = yield* connectionView(session);
  const threadSearch = yield* ThreadSearch.ThreadSearch;
  const sql = yield* SqlClient.SqlClient;
  return yield* view.searchThreads(input, (request, narrowed) =>
    ThreadSearch.searchThreadsWithOlderSettledRows({
      request,
      search: (search) =>
        (queries === undefined ? Effect.void : Ref.update(queries, (n) => n + 1)).pipe(
          Effect.andThen(threadSearch.search({ ...search, ...narrowed })),
        ),
      searchOlderSettled: threadSearch.searchOlderSettled,
      sql,
      readThreads: () => Effect.succeed(Effect.die("older settled rows were read")),
      latestSequence: Effect.succeed(0),
    }),
  );
});

const matchedThreads = (
  session: Parameters<typeof connectionView>[0],
  query: string,
  extra: Partial<OrchestrationV2SearchThreadsInput> = {},
) =>
  searchAs(session, { query, ...extra }).pipe(
    Effect.map(({ matches }) => matches.map((match) => match.threadId).toSorted()),
  );

it.layer(layer)("Message search for a narrowed connection", (it) => {
  it.effect("reaches only the threads shared with the person, at either level", () =>
    Effect.gen(function* () {
      const inProject = ThreadId.make("thread:search-in-project");
      const sharedThread = ThreadId.make("thread:search-shared-thread");
      const unshared = ThreadId.make("thread:search-unshared");
      yield* seed([
        thread(inProject, SHARED),
        message(inProject, "in-project", "amberquartz in the shared project"),
        thread(sharedThread, PRIVATE),
        message(sharedThread, "shared-thread", "amberquartz in the shared thread"),
        thread(unshared, PRIVATE),
        message(unshared, "unshared", "amberquartz and violetvault nobody else may read"),
      ]);
      const all = [inProject, sharedThread, unshared].toSorted();

      assert.deepEqual(yield* matchedThreads(OWNER, "amberquartz"), all);
      const projectViewer = yield* deviceOf("Project viewer", [
        { scope: { kind: "project", projectId: SHARED }, level: "viewer" },
      ]);
      const projectCollaborator = yield* deviceOf("Project collaborator", [
        { scope: { kind: "project", projectId: SHARED }, level: "collaborator" },
      ]);
      const threadViewer = yield* deviceOf("Thread viewer", [
        { scope: { kind: "thread", threadId: sharedThread }, level: "viewer" },
      ]);
      const threadCollaborator = yield* deviceOf("Thread collaborator", [
        { scope: { kind: "thread", threadId: sharedThread }, level: "collaborator" },
      ]);
      const serverViewer = yield* deviceOf("Server viewer", [
        { scope: { kind: "server" }, level: "viewer" },
      ]);
      assert.deepEqual(yield* matchedThreads(projectViewer, "amberquartz"), [inProject]);
      assert.deepEqual(yield* matchedThreads(projectCollaborator, "amberquartz"), [inProject]);
      assert.deepEqual(yield* matchedThreads(threadViewer, "amberquartz"), [sharedThread]);
      assert.deepEqual(yield* matchedThreads(threadCollaborator, "amberquartz"), [sharedThread]);
      assert.deepEqual(yield* matchedThreads(serverViewer, "amberquartz"), all);

      // A match only in a thread they don't reach comes back as nothing: no thread, no snippet.
      assert.deepEqual(yield* searchAs(threadViewer, { query: "violetvault" }), { matches: [] });
      assert.deepEqual(yield* matchedThreads(OWNER, "violetvault"), [unshared]);
    }),
  );

  it.effect("runs no search for an unclaimed device or someone who reaches nothing", () =>
    Effect.gen(function* () {
      const queries = yield* Ref.make(0);
      const unclaimed = (yield* device(null, LEVEL_PERMISSIONS.viewer)).identity;
      const nobody = yield* deviceOf("Nobody", []);
      for (const session of [unclaimed, nobody]) {
        assert.deepEqual(yield* searchAs(session, { query: "amberquartz" }, queries), {
          matches: [],
        });
      }
      assert.strictEqual(yield* Ref.get(queries), 0);
      yield* searchAs(OWNER, { query: "amberquartz" }, queries);
      assert.strictEqual(yield* Ref.get(queries), 1);
    }),
  );

  it.effect("never returns older settled rows to a narrowed connection", () =>
    Effect.gen(function* () {
      const settled = ThreadId.make("thread:search-settled");
      yield* seed([
        thread(settled, SHARED, at(1)),
        message(settled, "settled", "a settled amberquartz note"),
      ]);
      const viewer = yield* deviceOf("Settled viewer", [
        { scope: { kind: "project", projectId: SHARED }, level: "viewer" },
      ]);
      // What upstream's client sends when its sidebar omits older settled threads; a narrowed
      // sidebar never does, so only a client asking on purpose sends it.
      const result = yield* searchAs(viewer, {
        query: "amberquartz",
        olderSettledBefore: DateTime.formatIso(at(30)),
        projectIds: [PRIVATE],
      });
      assert.isUndefined(result.threads);
      assert.isUndefined(result.snapshotSequence);
      assert.include(
        result.matches.map((match) => match.threadId),
        settled,
      );
    }),
  );

  it.effect("ranks a narrowed search without the owner's picks", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const busy = ThreadId.make("thread:search-busy");
      const picked = ThreadId.make("thread:search-picked");
      yield* seed([
        thread(busy, SHARED),
        message(busy, "busy-1", "plover notes", 3),
        message(busy, "busy-2", "more plover notes", 4),
        thread(picked, SHARED),
        message(picked, "picked", "one plover mention", 1),
      ]);
      // A pick at time 0 would read as no pick.
      yield* TestClock.adjust("1 day");
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.opens', json(${JSON.stringify({
          openedAt: now,
          score: 5,
          picks: [{ query: "plover", at: now }],
        })}))
        WHERE thread_id = ${picked}
      `;
      const viewer = yield* deviceOf("Ranked viewer", [
        { scope: { kind: "project", projectId: SHARED }, level: "viewer" },
      ]);
      assert.deepEqual(yield* matchedThreads(OWNER, "plover", { limit: 1 }), [picked]);
      assert.deepEqual(yield* matchedThreads(viewer, "plover", { limit: 1 }), [busy]);
    }),
  );
});
