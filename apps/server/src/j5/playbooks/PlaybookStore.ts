import type { SessionReach } from "../sharing/PersonAccess.ts";
import { makePlaybookCheckpoints } from "./PlaybookCheckpoints.ts";
import { type RunId, ThreadId } from "@t3tools/contracts";
import {
  PlaybookError,
  PlaybookHolderStop,
  PlaybookRevision,
  type PlaybookReviseRequest,
  PLAYBOOK_RUNS_PAGE_SIZE,
  PLAYBOOK_MAX_BYTES,
  PLAYBOOK_NAME_PATTERN,
  suggestPlaybookName,
  PlaybookDefinition,
  type PlaybookReadResponse,
  type PlaybookRun,
  type PlaybookRunsRequest,
  type PlaybookStep,
  type PlaybookStepResponse,
  type PlaybookWarning,
  type PlaybookSource,
  type PlaybookSaveRequest,
  type PlaybookFoldersInput,
} from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";
import { makePlaybookLibrary, selectPlaybookSource } from "./PlaybookLibrary.ts";
import {
  decodePlaybookDocument,
  playbookDigest,
  playbookError,
  storageError,
} from "./definition.ts";
export { playbookError } from "./definition.ts";

import { makeAgentPersonaLibrary, personaCatalogProblem } from "../agents/agentPersonaLibrary.ts";
import { durationMsBetween, j5AnalyticsRecorder } from "../analytics/recorder.ts";
import { participantIdForThread } from "../a2a/HomeRegistrar.ts";

const isPlaybookError = Schema.is(PlaybookError);
// Any file stem that stays inside the playbook directory; such files are listed and deletable
// even when their name is invalid, so a misnamed file never disappears without a way out.
const PLAYBOOK_FILE_STEM = /^[^/\\\p{Cc}]+$/u;
const invalidNameIssue = (file: string) => {
  const suggestion = suggestPlaybookName(file.slice(0, -5));
  return playbookError(
    "invalid_name",
    suggestion
      ? `Rename ${file} to ${suggestion}.yaml. Playbook names use lowercase letters, digits, and hyphens.`
      : `Rename ${file} using lowercase letters, digits, and hyphens.`,
  );
};
const Request = Schema.fromJsonString(Schema.Array(Schema.NullOr(Schema.String)));
const encodeRequest = Schema.encodeSync(Request);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeRequest = Schema.decodeUnknownEffect(Request);
type NamedStep = PlaybookStep & { readonly persona: string };
const namedSteps = (steps: ReadonlyArray<PlaybookStep>) =>
  steps.filter((step): step is NamedStep => step.persona !== undefined);
const stepSummary = ({ id, title, persona, approval }: PlaybookStep) => ({
  id,
  title,
  ...(persona === undefined ? {} : { persona }),
  ...(approval === undefined ? {} : { approval }),
});

/** Warnings retain uncertainty about absent personas when source files are invalid. */
const stepPersonaWarnings = (
  steps: ReadonlyArray<PlaybookStep>,
  catalog: Parameters<typeof personaCatalogProblem>[0] & {
    readonly diagnostics: ReadonlyArray<unknown>;
  },
): Array<PlaybookWarning> =>
  namedSteps(steps).flatMap((step): Array<PlaybookWarning> => {
    const problem = personaCatalogProblem(catalog, step.persona);
    if (problem === null) return [];
    const unverified = problem === "missing" && catalog.diagnostics.length > 0;
    return [
      {
        code: unverified
          ? "persona_unverified"
          : problem === "missing"
            ? "persona_missing"
            : "persona_disabled",
        stepId: step.id,
        persona: step.persona,
        message: unverified
          ? `Step "${step.id}" names persona "${step.persona}", which could not be checked because some persona files are invalid. Check Settings → Agent Setup.`
          : problem === "missing"
            ? `Step "${step.id}" names persona "${step.persona}", which is not in this environment's library.`
            : `Step "${step.id}" names persona "${step.persona}", which is turned off.`,
      },
    ];
  });

export type StoredPlaybookRun = PlaybookRun & {
  readonly definition: PlaybookDefinition | null;
  readonly holderParticipantId: string | null;
  readonly holderThreadId: ThreadId | null;
  readonly assignedByParticipantId: string | null;
};
const DefinitionJson = Schema.fromJsonString(PlaybookDefinition);
const decodeDefinition = Schema.decodeUnknownSync(DefinitionJson);
const encodeDefinition = Schema.encodeSync(DefinitionJson);
const RevisionJson = Schema.fromJsonString(PlaybookRevision);
const decodeRevision = Schema.decodeUnknownSync(RevisionJson);
const encodeRevision = Schema.encodeSync(RevisionJson);

const HolderStopJson = Schema.fromJsonString(PlaybookHolderStop);
const encodeHolderStop = Schema.encodeSync(HolderStopJson);
const decodeHolderStop = Schema.decodeUnknownSync(HolderStopJson);

type RunRow = {
  run_id: string;
  owner_thread_id: string;
  definition_path: string;
  current_step_id: string;
  holder_participant_id: string | null;
  holder_thread_id: string | null;
  assigned_by_participant_id: string | null;
  status: PlaybookRun["status"];
  created_at: string;
  updated_at: string;
  crew_instance_id: string | null;
  definition_json: string | null;
  cancel_reason: string | null;
  holder_stop_json: string | null;
  revision_count: number;
  latest_revision_json: string | null;
};
const fromRow = (row: RunRow): StoredPlaybookRun => ({
  definition: row.definition_json === null ? null : decodeDefinition(row.definition_json),
  cancelReason: row.cancel_reason,
  holderStop: row.holder_stop_json == null ? null : decodeHolderStop(row.holder_stop_json),
  revisionCount: row.revision_count,
  latestRevision:
    row.latest_revision_json === null ? null : decodeRevision(row.latest_revision_json),
  runId: row.run_id,
  ownerThreadId: ThreadId.make(row.owner_thread_id),
  definitionPath: row.definition_path,
  currentStepId: row.current_step_id,
  holderParticipantId: row.holder_participant_id,
  holderThreadId: row.holder_thread_id === null ? null : ThreadId.make(row.holder_thread_id),
  assignedByParticipantId: row.assigned_by_participant_id,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.crew_instance_id === null ? {} : { crewInstanceId: row.crew_instance_id }),
});

/** One recorded step landing and how its hand-off resolved. */
export type PlaybookLanding = {
  readonly runId: string;
  readonly requestId: string;
  readonly stepId: string;
  readonly landedAt: string;
  /** Set once, at first resolution; null with a target thread means the Captain. */
  readonly targetSeat: string | null;
  readonly targetThreadId: string | null;
  readonly targetParticipantId: string | null;
  readonly assignedByParticipantId: string | null;
  readonly outcome: "delivered" | "captain" | "skipped" | null;
  readonly resolvedAt: string | null;
};
type LandingRow = {
  run_id: string;
  request_id: string;
  step_id: string;
  landed_at: string;
  target_seat: string | null;
  target_thread_id: string | null;
  target_participant_id: string | null;
  assigned_by_participant_id: string | null;
  outcome: PlaybookLanding["outcome"];
  resolved_at: string | null;
};
const landingFromRow = (row: LandingRow): PlaybookLanding => ({
  runId: row.run_id,
  requestId: row.request_id,
  stepId: row.step_id,
  landedAt: row.landed_at,
  targetSeat: row.target_seat,
  targetThreadId: row.target_thread_id,
  targetParticipantId: row.target_participant_id,
  assignedByParticipantId: row.assigned_by_participant_id,
  outcome: row.outcome,
  resolvedAt: row.resolved_at,
});
export type PlaybookMutation = {
  readonly runId: string;
  readonly client_request_id: string;
  readonly summary?: string;
} & (
  | {
      readonly operation: "next" | "back";
      readonly expectedStepId: string;
      readonly assignee?: string | undefined;
    }
  | {
      readonly operation: "assign";
      readonly expectedStepId: string;
      readonly assignee?: string | undefined;
    }
  | { readonly operation: "complete"; readonly expectedStepId: string }
  | ({ readonly operation: "revise" } & PlaybookReviseRequest)
  | { readonly operation: "cancel" }
);

export const makePlaybookStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const checkpoints = makePlaybookCheckpoints(sql);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* SecureRandom.SecureRandom;
  const personas = yield* makeAgentPersonaLibrary;
  const library = yield* makePlaybookLibrary;
  const revision = yield* SubscriptionRef.make(0);
  const bumpRevision = SubscriptionRef.update(revision, (value) => value + 1);
  const notifyChange = (result: PlaybookStepResponse) =>
    result.replayed ? Effect.void : bumpRevision;
  // Serialize definition edits and run mutations within this environment.
  const permit = yield* Semaphore.make(1);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const recordAnalytics = yield* j5AnalyticsRecorder;

  /** `unreadable` replaces the default read-failure message, which names the file's absolute path. */
  const readDefinitionDocument = Effect.fn("PlaybookStore.readDefinitionDocument")(
    function* (definitionPath: string, _unreadable?: string) {
      const root = path.resolve(definitionPath, "../../..");
      const realRoot = yield* fs.realPath(root);
      const realFile = yield* fs.realPath(definitionPath);
      const relative = path.relative(realRoot, realFile);
      if (
        path.basename(path.dirname(path.dirname(definitionPath))) === ".j5" &&
        (relative.startsWith("..") || path.isAbsolute(relative))
      ) {
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
      const realDirectory = yield* fs.realPath(path.dirname(definitionPath));
      if (path.dirname(realFile) !== realDirectory)
        return yield* playbookError(
          "invalid_path",
          "Playbook files must stay inside their source folder.",
        );
      const text = yield* fs.readFileString(realFile);
      return yield* decodePlaybookDocument(text).pipe(
        Effect.mapError((error) =>
          playbookError(
            error.code,
            _unreadable ?? `Cannot read this playbook. Fix its YAML and retry. ${error.message}`,
            error.availableStepIds,
          ),
        ),
      );
    },
    (effect, _definitionPath: string, unreadable?: string) =>
      Effect.mapError(effect, (error) =>
        isPlaybookError(error)
          ? error
          : playbookError(
              "invalid_definition",
              unreadable ??
                `Cannot read this playbook. Fix its YAML and retry. ${error instanceof Error ? error.message : String(error)}`,
            ),
      ),
  );
  const readDefinition = Effect.fn("PlaybookStore.readDefinition")(function* (
    definitionPath: string,
  ) {
    return (yield* readDefinitionDocument(definitionPath)).definition;
  });

  const cancelOwner = Effect.fn("PlaybookStore.cancelOwner")(function* (
    owner: ThreadId,
    reason: "owner_archived" | "owner_deleted",
    runId?: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const timestamp = yield* now;
        const rows = yield* sql<RunRow>`UPDATE j5_playbook_run
        SET status = 'cancelled', cancel_reason = ${reason}, updated_at = ${timestamp}
        WHERE owner_thread_id = ${owner} AND status = 'active'
        ${runId === undefined ? sql`` : sql`AND run_id = ${runId}`}
        RETURNING *`;
        for (const row of rows) {
          yield* skipPending(row.run_id, timestamp);
          yield* checkpoints.close(row.run_id, timestamp);
        }
        if (rows.length > 0) yield* bumpRevision;
        return rows.map(fromRow);
      }),
    );
  }, Effect.mapError(storageError));
  const cancelOrphans = Effect.fn("PlaybookStore.cancelOrphans")(function* () {
    const rows = yield* sql<{
      run_id: string;
      owner_thread_id: string;
      archived_at: string | null;
      deleted_at: string | null;
    }>`
      SELECT run.run_id, run.owner_thread_id, thread.archived_at, thread.deleted_at FROM j5_playbook_run run
      LEFT JOIN orchestration_v2_projection_threads thread ON thread.thread_id = run.owner_thread_id
      WHERE run.status = 'active' AND (thread.thread_id IS NULL OR thread.deleted_at IS NOT NULL OR thread.archived_at IS NOT NULL)`;
    for (const row of rows)
      yield* cancelOwner(
        ThreadId.make(row.owner_thread_id),
        row.archived_at !== null && row.deleted_at === null ? "owner_archived" : "owner_deleted",
        row.run_id,
      );
  });
  const requireOwner = Effect.fn("PlaybookStore.requireOwner")(function* (owner: ThreadId) {
    const rows = yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads
      WHERE thread_id = ${owner} AND deleted_at IS NULL AND archived_at IS NULL`;
    if (!rows[0])
      return yield* playbookError(
        "thread_not_found",
        "The owner thread is archived, deleted, or unavailable.",
      );
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
        "No playbook run was found. Use j5_playbook_list and j5_playbook_start.",
      );
    if (row.owner_thread_id !== owner)
      return yield* playbookError(
        "not_owner",
        "Only the run's owner thread can access its agent tools.",
      );
    return fromRow(row);
  });

  const present = (
    { definition: _snapshot, ...run }: StoredPlaybookRun,
    definition: PlaybookDefinition | null,
    replayed = false,
  ): PlaybookStepResponse => {
    const index = definition?.steps.findIndex((step) => step.id === run.currentStepId) ?? -1;
    return {
      ...run,
      title: definition?.title ?? path.basename(run.definitionPath, ".yaml"),
      description: definition?.description ?? "",
      steps: definition?.steps.map(({ id, title }) => ({ id, title })) ?? [],
      position: index < 0 ? null : index + 1,
      total: definition?.steps.length ?? 0,
      currentStep: definition?.steps[index] ?? null,
      replayed,
    };
  };
  const view = Effect.fn("PlaybookStore.view")(function* (
    run: StoredPlaybookRun,
    replayed = false,
  ) {
    return {
      ...present(run, run.definition, replayed),
      checkpoint: yield* checkpoints.current(run.runId),
    };
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
  type Holder = {
    participantId: string;
    threadId: ThreadId;
    assignedBy: string;
    seat: string | null;
  };
  const resolveHolder = Effect.fn("PlaybookStore.resolveHolder")(function* (
    owner: ThreadId,
    assignee?: string,
  ) {
    const ownerRows = yield* sql<{
      project_id: string;
      participant_id: string;
    }>`SELECT project_id, participant_id FROM j5_a2a_membership
      WHERE thread_id = ${owner} AND archived_at IS NULL`;
    const ownerRow = ownerRows.length === 1 ? ownerRows[0] : undefined;
    const assignedBy = ownerRow?.participant_id ?? participantIdForThread(owner);
    if (assignee === undefined)
      return { participantId: assignedBy, threadId: owner, assignedBy, seat: null };
    if (!ownerRow)
      return yield* playbookError(
        "invalid_assignee",
        "The owner has no active participant identity for a hand-off.",
      );
    const targets = yield* sql<{
      project_id: string;
      participant_id: string;
      thread_id: string;
      archived_at: string | null;
    }>`SELECT project_id, participant_id, thread_id, archived_at FROM j5_a2a_membership
      WHERE participant_id = ${assignee}`;
    if (
      targets.length !== 1 ||
      targets[0]!.project_id !== ownerRow.project_id ||
      targets[0]!.archived_at !== null
    )
      return yield* playbookError(
        "invalid_assignee",
        `Participant ${assignee} is not an active local agent in the owner's project.`,
      );
    const target = targets[0]!;
    if (target.thread_id === owner)
      return yield* playbookError(
        "invalid_assignee",
        "Omit assignee to keep the step with its owner.",
      );
    const threads = yield* sql<{
      thread_id: string;
    }>`SELECT thread_id FROM orchestration_v2_projection_threads
      WHERE thread_id = ${target.thread_id} AND archived_at IS NULL AND deleted_at IS NULL`;
    if (threads.length !== 1)
      return yield* playbookError(
        "invalid_assignee",
        `Participant ${assignee}'s thread is archived, deleted, or unavailable.`,
      );
    const crew = yield* sql<{
      seat_name: string;
    }>`SELECT member.seat_name FROM j5_agent_crew_member member
      JOIN j5_agent_crew_instance instance ON instance.id = member.crew_instance_id
      WHERE member.participant_id = ${assignee} AND instance.captain_thread_id = ${owner}
        AND instance.archived_at IS NULL LIMIT 1`;
    if (crew[0])
      return {
        participantId: assignee,
        threadId: ThreadId.make(target.thread_id),
        assignedBy,
        seat: crew[0].seat_name,
      };
    const spawned = yield* sql<{
      participant_id: string;
    }>`SELECT participant_id FROM j5_a2a_participant_placement
      WHERE project_id = ${ownerRow.project_id} AND participant_id = ${assignee}
        AND provenance_kind = 'spawned-by' AND provenance_participant_id = ${assignedBy}
      LIMIT 1`;
    if (!spawned[0])
      return yield* playbookError(
        "invalid_assignee",
        `Participant ${assignee} was not spawned by this owner and is not a member of a Crew it captains.`,
      );
    return {
      participantId: assignee,
      threadId: ThreadId.make(target.thread_id),
      assignedBy,
      seat: null,
    };
  });
  // Target and attribution are committed with the run pointer, so a retry cannot change holders.
  const land = (
    runId: string,
    requestId: string,
    stepId: string,
    landedAt: string,
    holder: Holder,
  ) =>
    sql`INSERT INTO j5_playbook_step_delivery (run_id, request_id, step_id, landed_at,
      target_seat, target_thread_id, target_participant_id, assigned_by_participant_id)
      VALUES (${runId}, ${requestId}, ${stepId}, ${landedAt}, ${holder.seat}, ${holder.threadId}, ${holder.participantId}, ${holder.assignedBy})`;
  const skipPending = (runId: string, resolvedAt: string) =>
    sql`UPDATE j5_playbook_step_delivery SET outcome = 'skipped', resolved_at = ${resolvedAt}
      WHERE run_id = ${runId} AND resolved_at IS NULL`;

  /**
   * Warnings never fail a read: the catalog is read only when a step names a persona, and an
   * unreadable catalog turns into persona_unverified warnings.
   */
  const personaWarnings = (
    steps: ReadonlyArray<PlaybookStep>,
    catalog: ReturnType<typeof personas.catalog>,
  ): Effect.Effect<Array<PlaybookWarning>> => {
    const named = namedSteps(steps);
    if (named.length === 0) return Effect.succeed([]);
    return catalog.pipe(
      Effect.map((catalog) => stepPersonaWarnings(named, catalog)),
      Effect.catch((error) =>
        Effect.succeed(
          named.map((step): PlaybookWarning => ({
            code: "persona_unverified",
            stepId: step.id,
            persona: step.persona,
            message: `Step "${step.id}" names persona "${step.persona}", which could not be checked: ${error instanceof Error ? error.message : String(error)}`,
          })),
        ),
      ),
    );
  };

  const discover = Effect.fn("PlaybookStore.discover")(function* (
    workspaceRoot: string,
    selectedSource?: PlaybookSource,
  ) {
    const sources = yield* library.sources(workspaceRoot);
    const selected =
      selectedSource === undefined
        ? sources
        : sources.filter(
            (entry) =>
              entry.source.kind === selectedSource.kind &&
              (entry.source.kind !== "folder" ||
                (selectedSource.kind === "folder" && entry.source.path === selectedSource.path)),
          );
    const names = [...new Set(selected.flatMap((entry) => entry.names))].sort();
    const catalog = yield* Effect.cached(personas.catalog());
    const playbooks = yield* Effect.forEach(names, (name) =>
      Effect.gen(function* () {
        const selection = selectPlaybookSource(selected, name, selectedSource !== undefined);
        const source = selection.entry!;
        const base = {
          name,
          source: source.source,
          overridesLibrary: selection.overridesLibrary,
          overridesFolder: selection.overridesFolder,
        };
        const issue = selection.issue;
        const read =
          issue === null
            ? readDefinition(path.join(source.path, `${name}.yaml`))
            : Effect.fail(issue);
        return yield* read.pipe(
          Effect.flatMap((definition) =>
            personaWarnings(definition.steps, catalog).pipe(
              Effect.map((warnings) => ({
                ...base,
                title: definition.title,
                description: definition.description,
                stepCount: definition.steps.length,
                steps: definition.steps.map(stepSummary),
                issue: PLAYBOOK_NAME_PATTERN.test(name) ? null : invalidNameIssue(`${name}.yaml`),
                warnings,
              })),
            ),
          ),
          Effect.catch((issue) =>
            Effect.succeed({
              ...base,
              title: `${name}.yaml`,
              description: "",
              stepCount: 0,
              steps: [],
              issue,
              warnings: [],
            }),
          ),
        );
      }),
    );
    return {
      playbooks,
      sources: sources.map(({ source, path, issue }) => ({ source, path, issue })),
    };
  }, Effect.mapError(storageError));

  const definitionPathFor = library.resolve;

  /** Resolve retries against their original receipt before consulting a changed catalog. */
  const startDefinitionPathFor = Effect.fn("PlaybookStore.startDefinitionPathFor")(function* (
    owner: ThreadId,
    workspaceRoot: string,
    name: string,
    key: string,
    crewInstanceId?: string,
  ) {
    const rows = yield* sql<{
      request_json: string;
    }>`SELECT request_json FROM j5_playbook_request WHERE owner_thread_id = ${owner} AND request_id = ${key}`;
    if (rows[0]) {
      const request = yield* decodeRequest(rows[0].request_json);
      const recordedPath = request[1];
      if (
        request[0] !== "start" ||
        !recordedPath ||
        path.basename(recordedPath, ".yaml") !== name.replace(/\.yaml$/, "") ||
        (request[2] ?? null) !== (crewInstanceId ?? null)
      )
        return yield* playbookError(
          "request_conflict",
          "This client_request_id belongs to a different operation. Use a new key for a new operation.",
        );
      return { definitionPath: recordedPath };
    }
    return yield* definitionPathFor(workspaceRoot, name);
  }, Effect.mapError(storageError));

  /** Reads a live definition without touching run state: no permit, no SQL, no revision bump. */
  const readPath = Effect.fn("PlaybookStore.readPath")(function* (definitionPath: string) {
    const stem = path.basename(definitionPath, ".yaml");
    if (!(yield* fs.exists(definitionPath)))
      return yield* playbookError(
        "not_found",
        `No playbook named ${stem} on this server. Use j5_playbook_list.`,
      );
    const definition = yield* readDefinition(definitionPath);
    return {
      name: stem,
      title: definition.title,
      description: definition.description,
      steps: definition.steps,
      warnings: yield* personaWarnings(definition.steps, personas.catalog()),
    } satisfies PlaybookReadResponse;
  }, Effect.mapError(storageError));
  const read = Effect.fn("PlaybookStore.read")(function* (workspaceRoot: string, name: string) {
    const { definitionPath, source } = yield* definitionPathFor(workspaceRoot, name);
    const response = yield* readPath(definitionPath);
    const digest = playbookDigest(yield* fs.readFileString(definitionPath));
    return { ...response, source, digest } satisfies PlaybookReadResponse;
  }, Effect.mapError(storageError));

  const removeDefinition = Effect.fn("PlaybookStore.removeDefinition")(function* (
    workspaceRoot: string,
    name: string,
    source: PlaybookSource = { kind: "workspace" },
  ) {
    if (source.kind === "folder")
      return yield* playbookError(
        "read_only",
        "Edit this playbook in its source folder or copy it to the environment library.",
      );
    if (!PLAYBOOK_FILE_STEM.test(name))
      return yield* playbookError("invalid_name", "Choose a playbook in this workspace.");
    const directory = yield* library.directoryFor(workspaceRoot, source);
    const filename = path.join(directory, `${name}.yaml`);
    return yield* Effect.gen(function* () {
      if (!(yield* fs.exists(filename)))
        return yield* playbookError("not_found", "This playbook no longer exists.");
      const realRoot = yield* fs.realPath(
        source.kind === "workspace" ? workspaceRoot : path.dirname(directory),
      );
      const realDirectory = yield* fs.realPath(directory);
      const relative = path.relative(realRoot, realDirectory);
      if (relative !== (source.kind === "workspace" ? path.join(".j5", "playbooks") : "playbooks"))
        return yield* playbookError("invalid_path", "Playbooks must stay inside the workspace.");
      const info = yield* fs.stat(filename);
      if (info.type !== "File")
        return yield* playbookError("invalid_path", "Only playbook YAML files can be deleted.");
      yield* fs.remove(filename);
      yield* bumpRevision;
      return { deleted: true };
    }).pipe(permit.withPermits(1));
  }, Effect.mapError(storageError));

  /** Returns the definition's YAML as a file a user can re-import. */
  const exportDefinition = Effect.fn("PlaybookStore.exportDefinition")(function* (
    workspaceRoot: string,
    name: string,
    source: PlaybookSource = { kind: "workspace" },
  ) {
    if (!PLAYBOOK_NAME_PATTERN.test(name))
      return yield* playbookError("invalid_name", "Choose a playbook in this workspace.");
    const filename = (yield* library.resolve(workspaceRoot, name, source)).definitionPath;
    if (!(yield* fs.exists(filename)))
      return yield* playbookError("not_found", "This playbook no longer exists.");
    // Export the validated source text (less any BOM): re-rendering can grow the file past the import limit.
    const { text } = yield* readDefinitionDocument(
      filename,
      "Cannot read this playbook. Fix its YAML in the library and retry.",
    );
    return { fileName: `${name}.yaml`, yaml: text };
  }, Effect.mapError(storageError));

  const renameDefinition = Effect.fn("PlaybookStore.renameDefinition")(function* (
    workspaceRoot: string,
    name: string,
    title: string,
    source: PlaybookSource = { kind: "workspace" },
  ) {
    if (source.kind === "folder")
      return yield* playbookError(
        "read_only",
        "Edit this playbook in its source folder or copy it to the environment library.",
      );
    if (!PLAYBOOK_NAME_PATTERN.test(name))
      return yield* playbookError("invalid_name", "Choose a playbook in this workspace.");
    const nextTitle = title.trim();
    if (!nextTitle) return yield* playbookError("invalid_title", "Enter a name for the playbook.");
    const filename = (yield* library.resolve(workspaceRoot, name, source)).definitionPath;
    return yield* Effect.gen(function* () {
      if (!(yield* fs.exists(filename)))
        return yield* playbookError("not_found", "This playbook no longer exists.");
      const { definition, document } = yield* readDefinitionDocument(filename);
      if (definition.title === nextTitle) return { renamed: false };
      document.set("title", nextTitle);
      yield* fs.writeFileString(filename, document.toString());
      yield* bumpRevision;
      return { renamed: true };
    }).pipe(permit.withPermits(1));
  }, Effect.mapError(storageError));

  const start = Effect.fn("PlaybookStore.start")(function* (
    owner: ThreadId,
    workspaceRoot: string,
    name: string,
    key: string,
    assignee?: string,
  ) {
    const { definitionPath } = yield* startDefinitionPathFor(owner, workspaceRoot, name, key);
    const request = encodeRequest(
      assignee === undefined
        ? ["start", definitionPath]
        : ["start", definitionPath, null, assignee],
    );
    return yield* Effect.gen(function* () {
      yield* cancelOrphans();
      const previous = yield* replay(owner, key, request);
      if (previous) return yield* view(previous, true);
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
          const definition = yield* readDefinition(definitionPath);
          const holder = yield* resolveHolder(owner, assignee);
          const timestamp = yield* now;
          const run: StoredPlaybookRun = {
            definition,
            cancelReason: null,
            revisionCount: 0,
            latestRevision: null,
            runId: yield* crypto.uuidV4().pipe(Effect.orDie),
            ownerThreadId: owner,
            definitionPath,
            currentStepId: definition.steps[0]!.id,
            holderParticipantId: holder.participantId,
            holderThreadId: holder.threadId,
            assignedByParticipantId: holder.assignedBy,
            status: "active",
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          yield* sql`INSERT INTO j5_playbook_run (run_id, owner_thread_id, definition_path, current_step_id, status, created_at, updated_at, definition_json,
            holder_participant_id, holder_thread_id, assigned_by_participant_id, start_event_sequence)
          VALUES (${run.runId}, ${owner}, ${definitionPath}, ${run.currentStepId}, ${run.status}, ${timestamp}, ${timestamp}, ${encodeDefinition(definition)},
            ${holder.participantId}, ${holder.threadId}, ${holder.assignedBy}, (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events))`;
          yield* land(run.runId, key, run.currentStepId, timestamp, holder);
          yield* remember(owner, key, request, run.runId);
          return { run, replayed: false };
        }),
      );
      if (result.replayed) return yield* view(result.run, true);
      const definition = result.run.definition!;
      yield* recordAnalytics("j5.playbook.run.started", {
        stepCount: definition.steps.length,
        stepsWithPersona: definition.steps.filter((step) => step.persona !== undefined).length,
        crewBound: false,
      });
      return present(result.run, definition);
    }).pipe(Effect.tap(notifyChange), permit.withPermits(1));
  }, Effect.mapError(storageError));

  /**
   * `j5.playbook.run.finished`, recorded once a run's end has committed. How far it got is read
   * from the saved copy.
   */
  const recordFinished = Effect.fn("PlaybookStore.recordFinished")(function* (
    run: StoredPlaybookRun,
    cause: "agent",
  ) {
    const definition = run.definition;
    const position =
      definition === null
        ? -1
        : definition.steps.findIndex((step) => step.id === run.currentStepId);
    yield* recordAnalytics("j5.playbook.run.finished", {
      outcome: run.status,
      cause,
      crewBound: run.crewInstanceId !== undefined && run.crewInstanceId !== null,
      ...(definition === null ? {} : { stepCount: definition.steps.length }),
      ...(position < 0 ? {} : { position: position + 1 }),
      ...durationMsBetween(run.createdAt, run.updatedAt),
    });
  });

  const mutate = Effect.fn("PlaybookStore.mutate")(function* (
    owner: ThreadId,
    input: PlaybookMutation,
  ) {
    const baseRequest = [
      input.operation,
      input.runId,
      "expectedStepId" in input ? input.expectedStepId : null,
      input.operation === "revise" ? (input.stepId ?? null) : null,
      ...(input.operation === "revise"
        ? [
            input.basis,
            playbookDigest(
              encodeJson(
                input.steps.map(({ id, title, prompt, persona, approval }) => ({
                  id,
                  title,
                  prompt,
                  ...(persona === undefined ? {} : { persona }),
                  ...(approval === undefined ? {} : { approval }),
                })),
              ),
            ),
          ]
        : []),
    ];
    if (input.summary !== undefined) baseRequest.push("summary", input.summary);
    const request = encodeRequest(
      "assignee" in input && input.assignee !== undefined
        ? [...baseRequest, input.assignee]
        : baseRequest,
    );
    return yield* Effect.gen(function* () {
      yield* cancelOrphans();
      const previous = yield* replay(owner, input.client_request_id, request);
      if (previous) return yield* view(previous, true);
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          const previous = yield* replay(owner, input.client_request_id, request);
          if (previous) return { run: previous, replayed: true };
          const run = yield* readRun(owner, input.runId);
          let definition = run.definition;
          if (run.status !== "active")
            return yield* playbookError(
              "run_terminal",
              `This run is ${run.status}. Start a new run to continue.`,
            );
          yield* requireOwner(owner);
          if ("expectedStepId" in input && input.expectedStepId !== run.currentStepId) {
            return yield* playbookError(
              "step_conflict",
              `Expected '${input.expectedStepId}', but the run is at '${run.currentStepId}'. Retrieve j5_playbook_current and use a new request ID.`,
            );
          }
          let currentStepId = run.currentStepId;
          let status: PlaybookRun["status"] = run.status;
          if (input.operation === "cancel") status = "cancelled";
          else if (input.operation === "revise") {
            if (definition === null)
              return yield* playbookError(
                "invalid_snapshot",
                "This run has no saved playbook copy.",
              );
            if (input.basis !== "asked" && input.basis !== "approved")
              return yield* playbookError(
                "invalid_definition",
                "A revision requires an asked or approved basis.",
              );
            const previousSteps = definition.steps;
            definition = (yield* decodePlaybookDocument(
              encodeJson({ ...definition, steps: input.steps }),
            )).definition;
            const requiredIds = new Set(
              definition.steps
                .filter((step) => step.approval === "required")
                .map((step) => step.id),
            );
            const removed = previousSteps.find(
              (step) => step.approval === "required" && !requiredIds.has(step.id),
            );
            if (removed)
              return yield* playbookError(
                "invalid_definition",
                `The revision must keep the required approval on step '${removed.id}'.`,
              );
            const ids = definition.steps.map((step) => step.id);
            if (!ids.includes(currentStepId)) {
              if (input.stepId === undefined || !ids.includes(input.stepId))
                return yield* playbookError(
                  "step_missing",
                  "The revision removes the current step. Name an available replacement stepId.",
                  ids,
                );
              currentStepId = input.stepId;
            }
          } else if (definition) {
            const ids = definition.steps.map((step) => step.id);
            const index = ids.indexOf(run.currentStepId);
            if (index < 0)
              return yield* playbookError("invalid_snapshot", "The run has no current step.");
            if (input.operation === "complete") status = "completed";
            else if (input.operation !== "assign") {
              const target = ids[index + (input.operation === "next" ? 1 : -1)];
              if (!target)
                return yield* playbookError(
                  "step_boundary",
                  input.operation === "next"
                    ? "This is the last step. Call j5_playbook_complete when the work is finished."
                    : "This is the first step.",
                  ids,
                );
              currentStepId = target;
            }
          }
          if (
            input.operation === "revise" &&
            currentStepId === run.currentStepId &&
            input.assignee !== undefined
          )
            return yield* playbookError(
              "invalid_assignee",
              "A revision that keeps the current step cannot change its holder. Use j5_playbook_assign.",
            );
          const holder =
            input.operation === "next" ||
            input.operation === "back" ||
            input.operation === "assign" ||
            (input.operation === "revise" && currentStepId !== run.currentStepId)
              ? yield* resolveHolder(owner, input.assignee)
              : null;
          const updatedAt = yield* now;
          if (input.operation === "next" || input.operation === "complete") {
            const step = run.definition?.steps.find((step) => step.id === run.currentStepId);
            if (step?.approval === "required") {
              const checkpoint = yield* checkpoints.current(run.runId);
              const summary = input.summary?.trim();
              const changedSummary = input.summary !== undefined && summary !== checkpoint?.summary;
              if (checkpoint?.status !== "approved" || changedSummary) {
                if (checkpoint?.status !== "pending" || changedSummary) {
                  if (!input.summary || !summary || input.summary.length > 8000)
                    return yield* playbookError(
                      "approval_summary_required",
                      "Submit a summary of the finished work to approve (1–8000 characters).",
                    );
                  if (checkpoint?.status === "pending")
                    yield* checkpoints.close(run.runId, updatedAt);
                  yield* checkpoints.open({
                    requestId: yield* crypto.uuidV4().pipe(Effect.orDie),
                    runId: run.runId,
                    ownerThreadId: owner,
                    stepId: step.id,
                    stepTitle: step.title,
                    summary,
                    status: "pending",
                    createdAt: updatedAt,
                    answeredAt: null,
                    reason: null,
                  });
                }
                return { run, replayed: false, approvalPending: true };
              }
            }
          }
          const oldStep = run.definition?.steps.find((step) => step.id === run.currentStepId);
          const newStep = definition?.steps.find((step) => step.id === currentStepId);
          if (
            input.operation !== "assign" &&
            (input.operation !== "revise" || encodeJson(oldStep) !== encodeJson(newStep))
          )
            yield* checkpoints.close(run.runId, updatedAt);
          let revisionCount = run.revisionCount ?? 0;
          let latestRevision = run.latestRevision ?? null;
          if (input.operation === "revise") {
            latestRevision = {
              basis: input.basis,
              revisedAt: updatedAt,
              ownerThreadId: owner,
              fromStepId: run.currentStepId,
              toStepId: currentStepId,
              stepsDigest: playbookDigest(encodeJson(definition!.steps)),
            };
            if (currentStepId === run.currentStepId && run.holderThreadId !== owner) {
              const previousStep = run.definition?.steps.find((step) => step.id === currentStepId);
              const revisedStep = definition!.steps.find((step) => step.id === currentStepId);
              if (previousStep?.prompt !== revisedStep?.prompt) {
                // Preserve the recipient and seat recorded for this step.
                yield* sql`INSERT INTO j5_playbook_step_delivery (run_id, request_id, step_id, landed_at,
                  target_seat, target_thread_id, target_participant_id, assigned_by_participant_id)
                  SELECT run_id, ${input.client_request_id}, step_id, ${updatedAt},
                    target_seat, target_thread_id, target_participant_id, assigned_by_participant_id
                  FROM j5_playbook_step_delivery WHERE run_id = ${run.runId} AND step_id = ${currentStepId}
                  ORDER BY landed_at DESC, rowid DESC LIMIT 1`;
              }
            }
            revisionCount += 1;
            yield* sql`INSERT INTO j5_playbook_revision (run_id, request_id, basis, revised_at, owner_thread_id, from_step_id, to_step_id, steps_digest)
              VALUES (${run.runId}, ${input.client_request_id}, ${input.basis}, ${updatedAt}, ${owner}, ${run.currentStepId}, ${currentStepId}, ${latestRevision.stepsDigest})`;
            yield* sql`UPDATE j5_playbook_run SET definition_json = ${encodeDefinition(definition!)}, revision_count = ${revisionCount}, latest_revision_json = ${encodeRevision(latestRevision)} WHERE run_id = ${run.runId}`;
          }
          yield* sql`UPDATE j5_playbook_run SET current_step_id = ${currentStepId}, status = ${status}, updated_at = ${updatedAt},
            cancel_reason = ${input.operation === "cancel" ? "agent_cancelled" : (run.cancelReason ?? null)},
            holder_participant_id = ${holder?.participantId ?? run.holderParticipantId},
            holder_thread_id = ${holder?.threadId ?? run.holderThreadId},
            assigned_by_participant_id = ${holder?.assignedBy ?? run.assignedByParticipantId}
          WHERE run_id = ${run.runId} AND owner_thread_id = ${owner}`;
          if (input.operation === "assign" || status !== "active")
            yield* skipPending(run.runId, updatedAt);
          if (holder !== null)
            yield* land(run.runId, input.client_request_id, currentStepId, updatedAt, holder);
          yield* remember(owner, input.client_request_id, request, run.runId);
          return {
            run: {
              ...run,
              cancelReason:
                input.operation === "cancel" ? "agent_cancelled" : (run.cancelReason ?? null),
              definition,
              currentStepId,
              status,
              updatedAt,
              revisionCount,
              latestRevision,
              holderParticipantId: holder?.participantId ?? run.holderParticipantId,
              holderThreadId: holder?.threadId ?? run.holderThreadId,
              assignedByParticipantId: holder?.assignedBy ?? run.assignedByParticipantId,
            },
            replayed: false,
          };
        }),
      );
      if ("approvalPending" in result) {
        yield* bumpRevision;
        return yield* playbookError(
          "approval_pending",
          "Waiting for a person to approve this checkpoint in the Inbox or owner chat. The run has not moved.",
        );
      }
      if (!result.replayed && result.run.status !== "active")
        yield* recordFinished(result.run, "agent");
      return yield* view(result.run, result.replayed);
    }).pipe(Effect.tap(notifyChange), permit.withPermits(1));
  }, Effect.mapError(storageError));

  const current = Effect.fn("PlaybookStore.current")(function* (owner: ThreadId, runId?: string) {
    yield* cancelOrphans();
    return yield* view(yield* readRun(owner, runId));
  }, Effect.mapError(storageError));
  const progressRows = Effect.fn("j5.playbooks.playbookStore.progressRows")(function* (
    rows: ReadonlyArray<RunRow>,
  ) {
    if (rows.length === 0) return [];
    const details = yield* sql<{
      run_id: string;
      blocked: number;
      waiting_for_approval: number;
      holder_name: string | null;
    }>`SELECT run.run_id,
      (run.status = 'active' AND COALESCE(checkpoint.status = 'pending', 0)) AS waiting_for_approval,
      (run.status = 'active' AND EXISTS (
        SELECT 1 FROM j5_a2a_membership membership
        JOIN j5_a2a_human_inbox inbox ON inbox.sender_id = membership.participant_id
        WHERE membership.thread_id = run.owner_thread_id AND inbox.status = 'open'
      )) AS blocked,
      CASE WHEN run.holder_thread_id <> run.owner_thread_id THEN holder.title END AS holder_name
      FROM j5_playbook_run run
      LEFT JOIN orchestration_v2_projection_threads holder ON holder.thread_id = run.holder_thread_id
      LEFT JOIN j5_playbook_checkpoint checkpoint ON checkpoint.request_id = run.checkpoint_request_id
      WHERE run.run_id IN ${sql.in(rows.map((row) => row.run_id))}`;
    const byRun = new Map(details.map((detail) => [detail.run_id, detail]));
    return rows.map((row) => {
      const run = fromRow(row);
      const {
        currentStep: _prompt,
        replayed: _replayed,
        ...progress
      } = present(run, run.definition);
      const detail = byRun.get(run.runId)!;
      return {
        ...progress,
        blocked: Boolean(detail.blocked),
        waitingForApproval: Boolean(detail.waiting_for_approval),
        holderName: detail.holder_name,
      };
    });
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
  /** A run by id, without the owner check the agent tools apply; null when none. */
  const runById = Effect.fn("PlaybookStore.runById")(function* (runId: string) {
    const rows = yield* sql<RunRow>`SELECT * FROM j5_playbook_run WHERE run_id = ${runId}`;
    return rows[0] ? fromRow(rows[0]) : null;
  }, Effect.mapError(storageError));
  /** The saved step a landing hands off, with its playbook. */
  const snapshotStep = Effect.fn("PlaybookStore.snapshotStep")(function* (
    run: StoredPlaybookRun,
    stepId: string,
  ) {
    const definition = run.definition;
    if (definition === null)
      return yield* playbookError("invalid_snapshot", "This run has no saved playbook copy.");
    const index = definition.steps.findIndex((step) => step.id === stepId);
    return {
      name: path.basename(run.definitionPath, ".yaml"),
      title: definition.title,
      step: definition.steps[index] ?? null,
      position: index + 1,
      total: definition.steps.length,
    };
  }, Effect.mapError(storageError));
  const landing = Effect.fn("PlaybookStore.landing")(function* (runId: string, requestId: string) {
    const rows = yield* sql<LandingRow>`SELECT * FROM j5_playbook_step_delivery
      WHERE run_id = ${runId} AND request_id = ${requestId}`;
    return rows[0] ? landingFromRow(rows[0]) : null;
  }, Effect.mapError(storageError));
  /** The newest landing of a run, optionally only those on one step. */
  const latestLanding = Effect.fn("PlaybookStore.latestLanding")(function* (
    runId: string,
    stepId?: string,
  ) {
    const rows = yield* sql<LandingRow>`SELECT * FROM j5_playbook_step_delivery
      WHERE run_id = ${runId} AND ${stepId === undefined ? sql`1 = 1` : sql`step_id = ${stepId}`}
      ORDER BY landed_at DESC, rowid DESC LIMIT 1`;
    return rows[0] ? landingFromRow(rows[0]) : null;
  }, Effect.mapError(storageError));
  /** Unresolved landings, oldest first; every run's when no run is named. */
  const pendingLandings = Effect.fn("PlaybookStore.pendingLandings")(function* (
    runId: string | null,
  ) {
    const rows = yield* sql<LandingRow>`SELECT * FROM j5_playbook_step_delivery
      WHERE resolved_at IS NULL AND ${runId === null ? sql`1 = 1` : sql`run_id = ${runId}`}
      ORDER BY landed_at, rowid`;
    return rows.map(landingFromRow);
  }, Effect.mapError(storageError));
  const resolveLanding = Effect.fn("PlaybookStore.resolveLanding")(function* (
    runId: string,
    requestId: string,
    outcome: NonNullable<PlaybookLanding["outcome"]>,
  ) {
    const resolvedAt = yield* now;
    const rows = yield* sql<{ run_id: string }>`UPDATE j5_playbook_step_delivery
      SET outcome = ${outcome}, resolved_at = ${resolvedAt}
      WHERE run_id = ${runId} AND request_id = ${requestId} AND resolved_at IS NULL
      RETURNING run_id`;
    // Fleet shows who holds the step, so a resolved hand-off refreshes it.
    if (rows.length > 0) yield* bumpRevision;
    return (yield* landing(runId, requestId))!;
  }, Effect.mapError(storageError));
  const claimHolderStop = Effect.fn("PlaybookStore.claimHolderStop")(function* (runId: string) {
    // Claim before external I/O: a crash must not let a retry stop unrelated later work.
    const outcome = encodeHolderStop({
      status: "failed",
      reason: "Stop outcome unavailable after cancellation; it will not be retried.",
    });
    const rows = yield* sql`UPDATE j5_playbook_run SET holder_stop_json = ${outcome}
      WHERE run_id = ${runId} AND status = 'cancelled' AND holder_stop_json IS NULL RETURNING run_id`;
    return rows.length > 0;
  }, Effect.mapError(storageError));
  const recordHolderStop = Effect.fn("PlaybookStore.recordHolderStop")(function* (
    runId: string,
    outcome: PlaybookHolderStop,
  ) {
    yield* sql`UPDATE j5_playbook_run SET holder_stop_json = ${encodeHolderStop(outcome)} WHERE run_id = ${runId} AND status = 'cancelled'`;
    yield* bumpRevision;
  }, Effect.mapError(storageError));
  const ownerLifecycleRuns = Effect.fn("PlaybookStore.ownerLifecycleRuns")(function* (
    owner: ThreadId,
    eventSequence: number,
  ) {
    // A read may already have cancelled the old run, and an unarchive may have
    // allowed its replacement to start before the daemon handles the archive.
    return yield* sql<{ run_id: string }>`SELECT run_id FROM j5_playbook_run
      WHERE owner_thread_id = ${owner} AND start_event_sequence < ${eventSequence}
        AND (status = 'active' OR (status = 'cancelled' AND holder_stop_json IS NULL
          AND cancel_reason IN ('owner_archived', 'owner_deleted', 'agent_cancelled')))`;
  }, Effect.mapError(storageError));
  const unreconciledCancellations = Effect.fn("PlaybookStore.unreconciledCancellations")(
    function* () {
      yield* cancelOrphans();
      return (yield* sql<RunRow>`SELECT * FROM j5_playbook_run WHERE status = 'cancelled' AND holder_stop_json IS NULL AND cancel_reason IN ('owner_archived', 'owner_deleted', 'agent_cancelled')`).map(
        fromRow,
      );
    },
    Effect.mapError(storageError),
  );
  /** A Crew's active run with its saved progress, or null. */
  const activeRunForCrew = Effect.fn("PlaybookStore.activeRunForCrew")(function* (
    crewInstanceId: string,
  ) {
    const rows = yield* sql<RunRow>`SELECT * FROM j5_playbook_run
      WHERE crew_instance_id = ${crewInstanceId} AND status = 'active' LIMIT 1`;
    return rows[0] ? yield* view(fromRow(rows[0])) : null;
  }, Effect.mapError(storageError));
  const activeRunSummaries = Effect.fn("PlaybookStore.activeRunSummaries")(function* (
    ownerThreadIds: ReadonlyArray<ThreadId>,
  ) {
    if (ownerThreadIds.length === 0) return [];
    const rows = yield* sql<
      RunRow & {
        delivery_outcome: PlaybookLanding["outcome"];
        delivery_resolved_at: string | null;
      }
    >`SELECT run.*, delivery.outcome AS delivery_outcome,
      delivery.resolved_at AS delivery_resolved_at
      FROM j5_playbook_run run
      LEFT JOIN j5_playbook_step_delivery delivery ON delivery.rowid = (
        SELECT landing.rowid FROM j5_playbook_step_delivery landing
        WHERE landing.run_id = run.run_id AND landing.step_id = run.current_step_id
        ORDER BY landing.landed_at DESC, landing.rowid DESC LIMIT 1
      )
      WHERE run.status = 'active' AND run.owner_thread_id IN ${sql.in([...ownerThreadIds])}`;
    return rows.map((row) => {
      const run = fromRow(row);
      const progress = present(run, run.definition);
      return {
        ownerThreadId: run.ownerThreadId,
        runId: run.runId,
        position: progress.position ?? 0,
        total: progress.total,
        stepId: run.currentStepId,
        stepTitle: progress.currentStep?.title ?? run.currentStepId,
        holderParticipantId: run.holderParticipantId,
        state:
          run.holderThreadId === run.ownerThreadId
            ? ("captain" as const)
            : row.delivery_outcome === "delivered"
              ? ("delivered" as const)
              : ("pending" as const),
      };
    });
  }, Effect.mapError(storageError));
  return {
    // Include the current revision so subscribing after a mutation still refreshes the view.
    changes: SubscriptionRef.changes(revision),
    pendingCheckpoints: Effect.fn("PlaybookStore.pendingCheckpoints")(function* (
      reach: SessionReach,
      threadId?: ThreadId,
    ) {
      yield* cancelOrphans();
      return yield* checkpoints.pending(reach, threadId);
    }, Effect.mapError(storageError)),
    countCheckpoints: Effect.fn("PlaybookStore.countCheckpoints")(function* (reach: SessionReach) {
      yield* cancelOrphans();
      return yield* checkpoints.count(reach);
    }, Effect.mapError(storageError)),
    answerCheckpoint: Effect.fn("PlaybookStore.answerCheckpoint")(function* (
      input: import("@t3tools/contracts/j5").PlaybookCheckpointAnswer,
    ) {
      return yield* checkpoints
        .answer(input, yield* now)
        .pipe(sql.withTransaction, Effect.tap(bumpRevision), permit.withPermits(1));
    }, Effect.mapError(storageError)),
    sources: () =>
      library.sources(undefined).pipe(
        Effect.map((folders) => ({
          folders: folders.map(({ source, path, issue }) => ({ source, path, issue })),
        })),
      ),
    saveDefinition: (input: PlaybookSaveRequest) =>
      library.save(input).pipe(permit.withPermits(1), Effect.tap(bumpRevision)),
    saveDefinitionFromTurn: Effect.fn("PlaybookStore.saveDefinitionFromTurn")(
      function* (threadId: ThreadId, runId: RunId | null, input: PlaybookSaveRequest) {
        // A later steer can change what the agent acts on before this run ends.
        const allowed =
          runId === null
            ? []
            : yield* sql<{ readonly allowed: number }>`
            WITH turn AS (
              SELECT thread_id, run_id, json_extract(payload_json, '$.userMessageId') AS initiating_id
              FROM orchestration_v2_projection_runs
              WHERE run_id = ${runId} AND thread_id = ${threadId}
                AND status IN ('starting', 'running', 'waiting')
            ),
            inputs AS (
              SELECT message.message_id, message.payload_json
              FROM turn
              JOIN orchestration_v2_projection_messages AS message
                ON message.thread_id = turn.thread_id AND message.run_id = turn.run_id
              WHERE message.role = 'user'
            ),
            authorized AS (
              SELECT input.message_id FROM inputs AS input
              JOIN orchestration_events AS event ON event.stream_id = ${threadId}
                AND event.aggregate_kind = 'thread' AND event.event_type = 'message.updated'
                AND json_extract(event.payload_json, '$.id') = input.message_id
              JOIN j5_human_message_command AS claim ON claim.command_id = event.command_id
              JOIN j5_a2a_person_level AS grant
                ON grant.person_id = claim.person_id AND grant.scope_kind = 'server'
              JOIN j5_a2a_human_person AS person ON person.person_id = claim.person_id
              WHERE json_extract(input.payload_json, '$.scheduledTaskId') IS NULL
                AND json_extract(input.payload_json, '$.senderThreadId') IS NULL
                AND json_extract(input.payload_json, '$.createdBy') = 'user'
                AND claim.settings_write = 1 AND grant.level = 'owner' AND person.removed_at IS NULL
            )
            SELECT 1 AS allowed FROM turn
            WHERE initiating_id IN (SELECT message_id FROM authorized)
              AND NOT EXISTS (
                SELECT 1 FROM inputs WHERE message_id NOT IN (SELECT message_id FROM authorized)
              )
            LIMIT 1
          `;
        if (allowed.length === 0) {
          return yield* playbookError(
            "owner_required",
            "Only an environment Owner can save a library playbook. Keep the full YAML draft in this conversation and ask an Owner to approve and save it in a new chat turn or in Settings.",
          );
        }
        return yield* library.save(input).pipe(Effect.tap(bumpRevision));
      },
      Effect.mapError(storageError),
      permit.withPermits(1),
    ),
    setFolders: (input: PlaybookFoldersInput) =>
      library.setFolders(input).pipe(permit.withPermits(1), Effect.tap(bumpRevision)),
    startDefinitionPathFor,
    discover,
    definitionPathFor,
    read,
    readPath,
    removeDefinition,
    exportDefinition,
    renameDefinition,
    start,
    current,
    mutate,
    listForThread,
    listAll,
    runById,
    snapshotStep,
    landing,
    latestLanding,
    pendingLandings,
    resolveLanding,
    cancelOwner,
    claimHolderStop,
    recordHolderStop,
    unreconciledCancellations,
    ownerLifecycleRuns,
    activeRunForCrew,
    activeRunSummaries,
  };
});

export class PlaybookStore extends Context.Service<
  PlaybookStore,
  Effect.Success<typeof makePlaybookStore>
>()("t3/j5/playbooks/PlaybookStore") {}
export const playbookStoreLayer = Layer.effect(PlaybookStore, makePlaybookStore);
