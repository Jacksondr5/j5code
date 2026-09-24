import { ThreadId } from "@t3tools/contracts";
import {
  PlaybookDefinition,
  PlaybookError,
  PLAYBOOK_RUNS_PAGE_SIZE,
  PLAYBOOK_MAX_BYTES,
  PLAYBOOK_NAME_PATTERN,
  type PlaybookRun,
  type PlaybookRunsRequest,
  type PlaybookStepResponse,
} from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { parseDocument } from "yaml";

const isPlaybookError = Schema.is(PlaybookError);
const decodeDefinition = Schema.decodeUnknownEffect(PlaybookDefinition);

export const playbookError = (
  code: string,
  message: string,
  availableStepIds: ReadonlyArray<string> = [],
) => new PlaybookError({ code, message, availableStepIds });
const storageError = (error: unknown) =>
  isPlaybookError(error)
    ? error
    : playbookError("operation_failed", error instanceof Error ? error.message : String(error));
const encodeRequest = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.NullOr(Schema.String))),
);
type RunRow = {
  run_id: string;
  owner_thread_id: string;
  definition_path: string;
  current_step_id: string;
  status: PlaybookRun["status"];
  created_at: string;
  updated_at: string;
};
const fromRow = (row: RunRow): PlaybookRun => ({
  runId: row.run_id,
  ownerThreadId: ThreadId.make(row.owner_thread_id),
  definitionPath: row.definition_path,
  currentStepId: row.current_step_id,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
export type PlaybookMutation = {
  readonly runId: string;
  readonly client_request_id: string;
} & (
  | { readonly operation: "next" | "back" | "complete"; readonly expectedStepId: string }
  | { readonly operation: "reselect"; readonly expectedStepId: string; readonly stepId: string }
  | { readonly operation: "cancel" }
);

export const makePlaybookStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const revision = yield* SubscriptionRef.make(0);
  const notifyChange = (result: PlaybookStepResponse) =>
    result.replayed ? Effect.void : SubscriptionRef.update(revision, (value) => value + 1);
  // Serialize definition edits and run mutations within this environment.
  const permit = yield* Semaphore.make(1);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const readDefinitionDocument = Effect.fn("PlaybookStore.readDefinitionDocument")(
    function* (definitionPath: string) {
      const root = path.resolve(definitionPath, "../../..");
      const realRoot = yield* fs.realPath(root);
      const realFile = yield* fs.realPath(definitionPath);
      const relative = path.relative(realRoot, realFile);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return yield* playbookError(
          "invalid_path",
          "Playbook definitions must remain inside the thread workspace.",
        );
      }
      const info = yield* fs.stat(realFile);
      if (info.type !== "File" || info.size > BigInt(PLAYBOOK_MAX_BYTES)) {
        return yield* playbookError(
          "invalid_definition",
          `Use a YAML file no larger than ${PLAYBOOK_MAX_BYTES / 1024} KiB.`,
        );
      }
      const text = yield* fs.readFileString(realFile);
      const { document, raw } = yield* Effect.try(() => {
        const document = parseDocument(text, { version: "1.2", uniqueKeys: true });
        const issue = document.errors[0] ?? document.warnings[0];
        if (issue) throw issue;
        return { document, raw: document.toJS({ maxAliasCount: 0 }) as unknown };
      });
      const definition = yield* decodeDefinition(raw);
      const ids = definition.steps.map((step) => step.id);
      if (new Set(ids).size !== ids.length) {
        return yield* playbookError(
          "invalid_definition",
          "Every playbook step must have a unique stable ID.",
          ids,
        );
      }
      return { definition, document };
    },
    Effect.mapError((error) =>
      isPlaybookError(error)
        ? error
        : playbookError(
            "invalid_definition",
            `Cannot read the live playbook. Restore or fix its YAML and retry; cancellation remains available. ${error instanceof Error ? error.message : String(error)}`,
          ),
    ),
  );
  const readDefinition = Effect.fn("PlaybookStore.readDefinition")(function* (
    definitionPath: string,
  ) {
    return (yield* readDefinitionDocument(definitionPath)).definition;
  });

  const cancelOrphans = Effect.fn("PlaybookStore.cancelOrphans")(function* () {
    const timestamp = yield* now;
    yield* sql`UPDATE j5_playbook_run SET status = 'cancelled', updated_at = ${timestamp}
      WHERE status = 'active' AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_threads AS thread
        WHERE thread.thread_id = owner_thread_id AND thread.deleted_at IS NULL
      )`;
  });
  const requireOwner = Effect.fn("PlaybookStore.requireOwner")(function* (owner: ThreadId) {
    const rows = yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads
      WHERE thread_id = ${owner} AND deleted_at IS NULL`;
    if (!rows[0]) return yield* playbookError("thread_not_found", "The owner thread was deleted.");
  });

  const readRun = Effect.fn("PlaybookStore.readRun")(function* (owner: ThreadId, runId?: string) {
    const rows =
      runId === undefined
        ? yield* sql<RunRow>`SELECT * FROM j5_playbook_run WHERE owner_thread_id = ${owner}
          ORDER BY (status = 'active') DESC, rowid DESC LIMIT 1`
        : yield* sql<RunRow>`SELECT * FROM j5_playbook_run WHERE run_id = ${runId}`;
    const row = rows[0];
    if (!row)
      return yield* playbookError(
        "run_not_found",
        "No playbook run was found. Use playbook_list and playbook_start.",
      );
    if (row.owner_thread_id !== owner)
      return yield* playbookError(
        "not_owner",
        "Only the run's owner thread can access its agent tools.",
      );
    return fromRow(row);
  });

  const present = (
    run: PlaybookRun,
    definition: PlaybookDefinition,
    replayed = false,
  ): PlaybookStepResponse => {
    const index = definition.steps.findIndex((step) => step.id === run.currentStepId);
    return {
      ...run,
      title: definition.title,
      description: definition.description,
      steps: definition.steps.map(({ id, title }) => ({ id, title })),
      position: index < 0 ? null : index + 1,
      total: definition.steps.length,
      currentStep: definition.steps[index] ?? null,
      replayed,
      issue:
        run.status === "active" && index < 0
          ? playbookError(
              "step_missing",
              `Step '${run.currentStepId}' no longer exists. Call playbook_reselect with expectedStepId '${run.currentStepId}' and one of the available step IDs, or cancel.`,
              definition.steps.map((step) => step.id),
            )
          : null,
    };
  };
  const view = Effect.fn("PlaybookStore.view")(function* (
    run: PlaybookRun,
    replayed = false,
    definition: ReturnType<typeof readDefinition> = readDefinition(run.definitionPath),
  ) {
    return yield* definition.pipe(
      Effect.map((definition) => present(run, definition, replayed)),
      Effect.catch((issue) =>
        Effect.succeed({
          ...run,
          title: path.basename(run.definitionPath, ".yaml"),
          description: "",
          steps: [],
          position: null,
          total: 0,
          currentStep: null,
          issue: run.status === "active" ? issue : null,
          replayed,
        } satisfies PlaybookStepResponse),
      ),
    );
  });
  const replay = Effect.fn("PlaybookStore.replay")(function* (
    owner: ThreadId,
    key: string,
    request: string,
  ) {
    const rows = yield* sql<{ request_json: string; run_id: string }>`SELECT request_json, run_id
      FROM j5_playbook_request WHERE owner_thread_id = ${owner} AND request_id = ${key}`;
    const receipt = rows[0];
    if (!receipt) return null;
    if (receipt.request_json !== request)
      return yield* playbookError(
        "request_conflict",
        "This client_request_id belongs to a different operation. Use a new key for a new operation.",
      );
    return yield* readRun(owner, receipt.run_id);
  });
  const remember = (owner: ThreadId, key: string, request: string, runId: string) =>
    sql`INSERT INTO j5_playbook_request (owner_thread_id, request_id, request_json, run_id)
      VALUES (${owner}, ${key}, ${request}, ${runId})`;

  const discover = Effect.fn("PlaybookStore.discover")(function* (workspaceRoot: string) {
    const directory = path.join(workspaceRoot, ".j5/playbooks");
    if (!(yield* fs.exists(directory))) return { playbooks: [] };
    const names = (yield* fs.readDirectory(directory))
      .filter((name) => name.endsWith(".yaml") && PLAYBOOK_NAME_PATTERN.test(name.slice(0, -5)))
      .sort();
    const playbooks = yield* Effect.forEach(names, (file) =>
      readDefinition(path.join(directory, file)).pipe(
        Effect.map((definition) => ({
          name: file.slice(0, -5),
          title: definition.title,
          description: definition.description,
          stepCount: definition.steps.length,
          steps: definition.steps.map(({ id, title }) => ({ id, title })),
          issue: null as PlaybookError | null,
        })),
        Effect.catch((issue) =>
          Effect.succeed({
            name: file.slice(0, -5),
            title: file,
            description: "",
            stepCount: 0,
            steps: [],
            issue,
          }),
        ),
      ),
    );
    return { playbooks };
  }, Effect.mapError(storageError));

  const removeDefinition = Effect.fn("PlaybookStore.removeDefinition")(function* (
    workspaceRoot: string,
    name: string,
  ) {
    if (!PLAYBOOK_NAME_PATTERN.test(name))
      return yield* playbookError("invalid_name", "Choose a playbook in this workspace.");
    const directory = path.resolve(workspaceRoot, ".j5/playbooks");
    const filename = path.join(directory, `${name}.yaml`);
    return yield* Effect.gen(function* () {
      if (!(yield* fs.exists(filename)))
        return yield* playbookError("not_found", "This playbook no longer exists.");
      const realRoot = yield* fs.realPath(workspaceRoot);
      const realDirectory = yield* fs.realPath(directory);
      const relative = path.relative(realRoot, realDirectory);
      if (relative !== path.join(".j5", "playbooks"))
        return yield* playbookError("invalid_path", "Playbooks must stay inside the workspace.");
      const info = yield* fs.stat(filename);
      if (info.type !== "File")
        return yield* playbookError("invalid_path", "Only playbook YAML files can be deleted.");
      yield* cancelOrphans();
      const active = yield* sql<{ run_id: string }>`SELECT run_id FROM j5_playbook_run
        WHERE definition_path = ${filename} AND status = 'active' LIMIT 1`;
      if (active[0])
        return yield* playbookError(
          "in_use",
          `Run '${active[0].run_id}' is active. Complete or cancel it before deleting this playbook.`,
        );
      yield* fs.remove(filename);
      return { deleted: true };
    }).pipe(permit.withPermits(1));
  }, Effect.mapError(storageError));

  const renameDefinition = Effect.fn("PlaybookStore.renameDefinition")(function* (
    workspaceRoot: string,
    name: string,
    title: string,
  ) {
    if (!PLAYBOOK_NAME_PATTERN.test(name))
      return yield* playbookError("invalid_name", "Choose a playbook in this workspace.");
    const nextTitle = title.trim();
    if (!nextTitle) return yield* playbookError("invalid_title", "Enter a name for the playbook.");
    const filename = path.resolve(workspaceRoot, ".j5/playbooks", `${name}.yaml`);
    return yield* Effect.gen(function* () {
      if (!(yield* fs.exists(filename)))
        return yield* playbookError("not_found", "This playbook no longer exists.");
      const { definition, document } = yield* readDefinitionDocument(filename);
      if (definition.title === nextTitle) return { renamed: false };
      document.set("title", nextTitle);
      yield* fs.writeFileString(filename, document.toString());
      return { renamed: true };
    }).pipe(permit.withPermits(1));
  }, Effect.mapError(storageError));

  const start = Effect.fn("PlaybookStore.start")(function* (
    owner: ThreadId,
    workspaceRoot: string,
    name: string,
    key: string,
  ) {
    const stem = name.endsWith(".yaml") ? name.slice(0, -5) : name;
    if (!PLAYBOOK_NAME_PATTERN.test(stem))
      return yield* playbookError(
        "invalid_name",
        "Pass the name of a .yaml file inside .j5/playbooks, without directories.",
      );
    const definitionPath = path.resolve(workspaceRoot, ".j5/playbooks", `${stem}.yaml`);
    const request = encodeRequest(["start", definitionPath]);
    return yield* Effect.gen(function* () {
      yield* cancelOrphans();
      const previous = yield* replay(owner, key, request);
      if (previous) return yield* view(previous, true);
      // Capture the live file before taking the shared SQLite write transaction.
      const definition = yield* readDefinition(definitionPath);
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          const previous = yield* replay(owner, key, request);
          if (previous) return { run: previous, replayed: true };
          yield* requireOwner(owner);
          const active = yield* sql<{ run_id: string }>`SELECT run_id FROM j5_playbook_run
          WHERE owner_thread_id = ${owner} AND status = 'active'`;
          if (active[0])
            return yield* playbookError(
              "already_active",
              `Run '${active[0].run_id}' is active. Retrieve, complete, or cancel it before starting another.`,
            );
          const timestamp = yield* now;
          const run: PlaybookRun = {
            runId: yield* crypto.randomUUIDv4,
            ownerThreadId: owner,
            definitionPath,
            currentStepId: definition.steps[0]!.id,
            status: "active",
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          yield* sql`INSERT INTO j5_playbook_run (run_id, owner_thread_id, definition_path, current_step_id, status, created_at, updated_at)
          VALUES (${run.runId}, ${owner}, ${definitionPath}, ${run.currentStepId}, ${run.status}, ${timestamp}, ${timestamp})`;
          yield* remember(owner, key, request, run.runId);
          return { run, replayed: false };
        }),
      );
      return result.replayed ? yield* view(result.run, true) : present(result.run, definition);
    }).pipe(Effect.tap(notifyChange), permit.withPermits(1));
  }, Effect.mapError(storageError));

  const mutate = Effect.fn("PlaybookStore.mutate")(function* (
    owner: ThreadId,
    input: PlaybookMutation,
  ) {
    const request = encodeRequest([
      input.operation,
      input.runId,
      "expectedStepId" in input ? input.expectedStepId : null,
      "stepId" in input ? input.stepId : null,
    ]);
    return yield* Effect.gen(function* () {
      yield* cancelOrphans();
      const previous = yield* replay(owner, input.client_request_id, request);
      if (previous) return yield* view(previous, true);
      const before = yield* readRun(owner, input.runId);
      const definition =
        input.operation === "cancel" || before.status !== "active"
          ? null
          : yield* readDefinition(before.definitionPath);
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          const previous = yield* replay(owner, input.client_request_id, request);
          if (previous) return { run: previous, replayed: true };
          const run = yield* readRun(owner, input.runId);
          if (run.status !== "active")
            return yield* playbookError(
              "run_terminal",
              `This run is ${run.status}. Start a new run to continue.`,
            );
          yield* requireOwner(owner);
          if ("expectedStepId" in input && input.expectedStepId !== run.currentStepId) {
            return yield* playbookError(
              "step_conflict",
              `Expected '${input.expectedStepId}', but the run is at '${run.currentStepId}'. Retrieve playbook_current and use a new request ID.`,
            );
          }
          let currentStepId = run.currentStepId;
          let status: PlaybookRun["status"] = run.status;
          if (input.operation === "cancel") status = "cancelled";
          else if (definition) {
            const ids = definition.steps.map((step) => step.id);
            const index = ids.indexOf(run.currentStepId);
            if (input.operation === "reselect") {
              if (!ids.includes(input.stepId))
                return yield* playbookError("step_missing", "Choose an available step ID.", ids);
              currentStepId = input.stepId;
            } else {
              if (index < 0) return yield* present(run, definition).issue!;
              if (input.operation === "complete") status = "completed";
              else {
                const target = ids[index + (input.operation === "next" ? 1 : -1)];
                if (!target)
                  return yield* playbookError(
                    "step_boundary",
                    input.operation === "next"
                      ? "This is the last step. Call playbook_complete when the work is finished."
                      : "This is the first step. Retrieve it or choose an available step explicitly.",
                    ids,
                  );
                currentStepId = target;
              }
            }
          }
          const updatedAt = yield* now;
          yield* sql`UPDATE j5_playbook_run SET current_step_id = ${currentStepId}, status = ${status}, updated_at = ${updatedAt}
          WHERE run_id = ${run.runId} AND owner_thread_id = ${owner}`;
          yield* remember(owner, input.client_request_id, request, run.runId);
          return { run: { ...run, currentStepId, status, updatedAt }, replayed: false };
        }),
      );
      return definition && !result.replayed
        ? present(result.run, definition)
        : yield* view(result.run, result.replayed);
    }).pipe(Effect.tap(notifyChange), permit.withPermits(1));
  }, Effect.mapError(storageError));

  const current = Effect.fn("PlaybookStore.current")(function* (owner: ThreadId, runId?: string) {
    yield* cancelOrphans();
    const result = yield* view(yield* readRun(owner, runId));
    if (result.issue && result.status === "active")
      return yield* playbookError(
        result.issue.code,
        `Run '${result.runId}' is at '${result.currentStepId}'. ${result.issue.message}`,
        result.issue.availableStepIds,
      );
    return result;
  }, Effect.mapError(storageError));
  const progressRows = (rows: ReadonlyArray<RunRow>) =>
    Effect.gen(function* () {
      // Keep the cache inside the request, including failed reads; the next request sees live YAML.
      const definitions = new Map<string, ReturnType<typeof readDefinition>>();
      return yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          let definition = definitions.get(row.definition_path);
          if (!definition) {
            definition = yield* Effect.cached(readDefinition(row.definition_path));
            definitions.set(row.definition_path, definition);
          }
          const {
            currentStep: _prompt,
            replayed: _replayed,
            ...progress
          } = yield* view(fromRow(row), false, definition);
          return progress;
        }),
      );
    });
  const listForThread = Effect.fn("PlaybookStore.listForThread")(function* (owner: ThreadId) {
    yield* cancelOrphans();
    const rows = yield* sql<RunRow>`SELECT * FROM j5_playbook_run WHERE owner_thread_id = ${owner}
      ORDER BY (status = 'active') DESC, rowid DESC LIMIT 20`;
    const runs = yield* progressRows(rows);
    return { runs };
  }, Effect.mapError(storageError));
  const listAll = Effect.fn("PlaybookStore.listAll")(function* (input: PlaybookRunsRequest) {
    yield* cancelOrphans();
    const filter = input.status === "active" ? sql`status = 'active'` : sql`1 = 1`;
    const counts = yield* sql<{
      total: number;
    }>`SELECT COUNT(*) AS total FROM j5_playbook_run WHERE ${filter}`;
    const rows = yield* sql<RunRow>`SELECT * FROM j5_playbook_run WHERE ${filter}
      ORDER BY ${input.status === "active" ? sql`updated_at DESC, rowid DESC` : sql`(status = 'active') DESC, updated_at DESC, rowid DESC`}
      LIMIT ${PLAYBOOK_RUNS_PAGE_SIZE} OFFSET ${input.offset ?? 0}`;
    const runs = yield* progressRows(rows);
    return { runs, total: counts[0]?.total ?? 0 };
  }, Effect.mapError(storageError));
  return {
    // Include the current revision so subscribing after a mutation still refreshes the view.
    changes: SubscriptionRef.changes(revision),
    discover,
    removeDefinition,
    renameDefinition,
    start,
    current,
    mutate,
    listForThread,
    listAll,
  };
});

export class PlaybookStore extends Context.Service<
  PlaybookStore,
  Effect.Success<typeof makePlaybookStore>
>()("t3/j5/playbooks/PlaybookStore") {}
export const playbookStoreLayer = Layer.effect(PlaybookStore, makePlaybookStore);
