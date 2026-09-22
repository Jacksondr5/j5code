import { ThreadId } from "@t3tools/contracts";
import {
  PlaybookDefinition,
  PlaybookError,
  PLAYBOOK_RUNS_PAGE_SIZE,
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
const namePattern = /^[^/\\\p{Cc}]+$/u;
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
  // ponytail: one permit per environment; split by owner only if tool traffic warrants it.
  const permit = yield* Semaphore.make(1);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const readDefinition = Effect.fn("PlaybookStore.readDefinition")(
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
      if (info.type !== "File" || info.size > 262144n) {
        return yield* playbookError(
          "invalid_definition",
          "Use a YAML file no larger than 256 KiB.",
        );
      }
      const text = yield* fs.readFileString(realFile);
      const raw = yield* Effect.try((): unknown => {
        const document = parseDocument(text, { version: "1.2", uniqueKeys: true });
        const issue = document.errors[0] ?? document.warnings[0];
        if (issue) throw issue;
        return document.toJS({ maxAliasCount: 0 });
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
      return definition;
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
        index < 0
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
          issue,
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
    return yield* view(yield* readRun(owner, receipt.run_id), true);
  });
  const remember = (owner: ThreadId, key: string, request: string, runId: string) =>
    sql`INSERT INTO j5_playbook_request (owner_thread_id, request_id, request_json, run_id)
      VALUES (${owner}, ${key}, ${request}, ${runId})`;

  const discover = Effect.fn("PlaybookStore.discover")(function* (workspaceRoot: string) {
    const directory = path.join(workspaceRoot, ".j5/playbooks");
    if (!(yield* fs.exists(directory))) return { playbooks: [] };
    const names = (yield* fs.readDirectory(directory))
      .filter((name) => name.endsWith(".yaml") && namePattern.test(name.slice(0, -5)))
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

  const start = Effect.fn("PlaybookStore.start")(function* (
    owner: ThreadId,
    workspaceRoot: string,
    name: string,
    key: string,
  ) {
    const stem = name.endsWith(".yaml") ? name.slice(0, -5) : name;
    if (!namePattern.test(stem))
      return yield* playbookError(
        "invalid_name",
        "Pass the name of a .yaml file inside .j5/playbooks, without directories.",
      );
    const definitionPath = path.resolve(workspaceRoot, ".j5/playbooks", `${stem}.yaml`);
    const request = encodeRequest(["start", definitionPath]);
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const previous = yield* replay(owner, key, request);
          if (previous) return previous;
          const active = yield* sql<{
            run_id: string;
          }>`SELECT run_id FROM j5_playbook_run WHERE owner_thread_id = ${owner} AND status = 'active'`;
          if (active[0])
            return yield* playbookError(
              "already_active",
              `Run '${active[0].run_id}' is active. Retrieve, complete, or cancel it before starting another.`,
            );
          const definition = yield* readDefinition(definitionPath);
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
          return present(run, definition);
        }),
      )
      .pipe(permit.withPermits(1));
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
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const previous = yield* replay(owner, input.client_request_id, request);
          if (previous) return previous;
          const run = yield* readRun(owner, input.runId);
          if (run.status !== "active")
            return yield* playbookError(
              "run_terminal",
              `This run is ${run.status}. Start a new run to continue.`,
            );
          if ("expectedStepId" in input && input.expectedStepId !== run.currentStepId) {
            return yield* playbookError(
              "step_conflict",
              `Expected '${input.expectedStepId}', but the run is at '${run.currentStepId}'. Retrieve playbook_current and use a new request ID.`,
            );
          }
          const definition =
            input.operation === "cancel" ? null : yield* readDefinition(run.definitionPath);
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
          const updated = { ...run, currentStepId, status, updatedAt };
          return definition ? present(updated, definition) : yield* view(updated);
        }),
      )
      .pipe(permit.withPermits(1));
  }, Effect.mapError(storageError));

  const current = Effect.fn("PlaybookStore.current")(function* (owner: ThreadId, runId?: string) {
    const result = yield* view(yield* readRun(owner, runId));
    if (result.issue && result.status === "active")
      return yield* playbookError(
        result.issue.code,
        `Run '${result.runId}' is at '${result.currentStepId}'. ${result.issue.message}`,
        result.issue.availableStepIds,
      );
    return result;
  }, Effect.mapError(storageError));
  const listForThread = Effect.fn("PlaybookStore.listForThread")(function* (owner: ThreadId) {
    const rows = yield* sql<RunRow>`SELECT * FROM j5_playbook_run WHERE owner_thread_id = ${owner}
      ORDER BY (status = 'active') DESC, rowid DESC LIMIT 20`;
    const runs = yield* Effect.forEach(rows, (row) =>
      view(fromRow(row)).pipe(
        Effect.map(({ currentStep: _prompt, replayed: _replayed, ...progress }) => progress),
      ),
    );
    return { runs };
  }, Effect.mapError(storageError));
  const listAll = Effect.fn("PlaybookStore.listAll")(function* (input: PlaybookRunsRequest) {
    const filter = input.status === "active" ? sql`status = 'active'` : sql`1 = 1`;
    const counts = yield* sql<{
      total: number;
    }>`SELECT COUNT(*) AS total FROM j5_playbook_run WHERE ${filter}`;
    const rows = yield* sql<RunRow>`SELECT * FROM j5_playbook_run WHERE ${filter}
      ORDER BY (status = 'active') DESC, updated_at DESC, rowid DESC
      LIMIT ${PLAYBOOK_RUNS_PAGE_SIZE} OFFSET ${input.offset ?? 0}`;
    // Read each live definition once per page, including failures. The next poll reads it afresh.
    const definitions = new Map<string, ReturnType<typeof readDefinition>>();
    const runs = yield* Effect.forEach(rows, (row) =>
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
    return { runs, total: counts[0]?.total ?? 0 };
  }, Effect.mapError(storageError));
  return { discover, start, current, mutate, listForThread, listAll };
});

export class PlaybookStore extends Context.Service<
  PlaybookStore,
  Effect.Success<typeof makePlaybookStore>
>()("t3/j5/playbooks/PlaybookStore") {}
export const playbookStoreLayer = Layer.effect(PlaybookStore, makePlaybookStore);
