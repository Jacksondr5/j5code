import * as Option from "effect/Option";
import {
  makePlaybookRequests,
  playbookRequestId,
  readPlaybookRequest,
} from "./PlaybookRequests.ts";
import { A2ALedgerTransactionWriter, layer as ledgerLayer } from "../a2a/LedgerService.ts";
import { A2ADeliveryWorker } from "../a2a/DeliveryWorker.ts";
import { typedByFirstOwner } from "../sharing/messageStamps.ts";
import {
  type OrchestrationV2ConversationMessage,
  OrchestrationV2AgentPersonaAssignment,
  ProjectId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import {
  PlaybookProgress,
  PlaybookError,
  PlaybookHolderStop,
  PlaybookRevision,
  PlaybookRequiredPersonas,
  type PlaybookReviseRequest,
  PLAYBOOK_RUNS_PAGE_SIZE,
  PLAYBOOK_MAX_BYTES,
  PLAYBOOK_PERSONA_EXCHANGE_PREFIX,
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
import { authorizeScheduledStart } from "./scheduledStart.ts";
export { playbookError } from "./definition.ts";

import { makeAgentPersonaLibrary, personaCatalogProblem } from "../agents/agentPersonaLibrary.ts";
import { durationMsBetween, j5AnalyticsRecorder } from "../analytics/recorder.ts";
import { assessRequiredPersonas } from "./requiredPersonas.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { CrewMemberModels } from "../agents/crewMemberModels.ts";
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
            ? `Step "${step.id}" has a required persona missing from this environment's library: "${step.persona}".`
            : `Step "${step.id}" has a required persona disabled in this environment: "${step.persona}".`,
      },
    ];
  });

export type StoredPlaybookRun = PlaybookRun & {
  readonly personaRequestId?: string;
  readonly definition: PlaybookDefinition | null;
  readonly personaBlockReason: string | null;
  readonly requiredPersonas: typeof PlaybookRequiredPersonas.Type | null;
  readonly holderParticipantId: string | null;
  readonly holderThreadId: ThreadId | null;
  readonly assignedByParticipantId: string | null;
};
const RequiredPersonasJson = Schema.fromJsonString(PlaybookRequiredPersonas);
const encodeRequiredPersonas = Schema.encodeSync(RequiredPersonasJson);
const decodeRequiredPersonas = Schema.decodeUnknownSync(RequiredPersonasJson);
const decodeAssignment = Schema.decodeUnknownSync(
  Schema.fromJsonString(OrchestrationV2AgentPersonaAssignment),
);
const decodeRuntimeMode = Schema.decodeUnknownSync(RuntimeMode);
const DefinitionJson = Schema.fromJsonString(PlaybookDefinition);
const readStepLabels = Schema.decodeUnknownOption(
  Schema.fromJsonString(PlaybookProgress.fields.steps),
);
const decodeDefinition = Schema.decodeUnknownOption(DefinitionJson);
const encodeDefinition = Schema.encodeSync(DefinitionJson);
const RevisionJson = Schema.fromJsonString(PlaybookRevision);
const decodeRevision = Schema.decodeUnknownSync(RevisionJson);
const encodeRevision = Schema.encodeSync(RevisionJson);

const HolderStopJson = Schema.fromJsonString(PlaybookHolderStop);
const encodeHolderStop = Schema.encodeSync(HolderStopJson);
const decodeHolderStop = Schema.decodeUnknownSync(HolderStopJson);

type RunRow = {
  checkpoint_summary: string | null;
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
  required_personas_json: string | null;
  persona_request_id: string | null;
  persona_block_reason: string | null;
  cancel_reason: string | null;
  holder_stop_json: string | null;
  revision_count: number;
  latest_revision_json: string | null;
};
const fromRow = (row: RunRow): StoredPlaybookRun => ({
  definition:
    row.definition_json === null ? null : Option.getOrNull(decodeDefinition(row.definition_json)),
  requiredPersonas:
    row.required_personas_json === null ? null : decodeRequiredPersonas(row.required_personas_json),
  ...(row.persona_request_id ? { personaRequestId: row.persona_request_id } : {}),
  personaBlockReason: row.persona_block_reason,
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

const buildPlaybookStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const writer = yield* A2ALedgerTransactionWriter;
  const delivery = yield* Effect.serviceOption(A2ADeliveryWorker);
  const requests = makePlaybookRequests(
    sql,
    writer,
    Option.isSome(delivery) ? delivery.value.notify : Effect.void,
  );
  const closeCheckpoint = Effect.fn(function* (runId: string, at: string) {
    const [row] = yield* sql<{
      checkpoint_request_id: string | null;
    }>`SELECT checkpoint_request_id FROM j5_playbook_run WHERE run_id = ${runId}`;
    if (!row?.checkpoint_request_id) return;
    yield* requests.close(row.checkpoint_request_id, at);
    yield* sql`UPDATE j5_playbook_run SET checkpoint_request_id = NULL, checkpoint_summary = NULL WHERE run_id = ${runId}`;
  });
  const currentCheckpoint = Effect.fn(function* (run: StoredPlaybookRun) {
    const [row] = yield* sql<{
      checkpoint_request_id: string | null;
      checkpoint_summary: string | null;
    }>`SELECT checkpoint_request_id, checkpoint_summary FROM j5_playbook_run WHERE run_id = ${run.runId}`;
    if (!row?.checkpoint_request_id || !run.currentStepId) return null;
    const state = yield* readPlaybookRequest(sql, row.checkpoint_request_id);
    if (!state) return null;
    return {
      ...state,
      requestId: row.checkpoint_request_id,
      runId: run.runId,
      ownerThreadId: run.ownerThreadId,
      stepId: run.currentStepId,
      stepTitle:
        run.definition?.steps.find((step) => step.id === run.currentStepId)?.title ??
        run.currentStepId,
      summary: row.checkpoint_summary ?? "",
    };
  });
  const initiatedByOwner = Effect.fn("PlaybookStore.initiatedByOwner")(function* (
    message: OrchestrationV2ConversationMessage | undefined,
  ) {
    if (message?.createdBy !== "user" || message.scheduledTaskId || message.senderThreadId)
      return false;
    const [author] = yield* sql<{ readonly allowed: number }>`
      SELECT EXISTS (
        SELECT 1 FROM j5_a2a_person_level AS level
        JOIN j5_a2a_human_person AS person ON person.person_id = level.person_id
        WHERE level.person_id = author.person_id AND person.removed_at IS NULL
          AND level.scope_kind = 'server' AND level.level = 'owner'
      ) AS allowed
      FROM j5_a2a_message_author AS author
      WHERE author.thread_id = ${message.threadId} AND author.message_id = ${message.id}
    `;
    if (author !== undefined) return author.allowed === 1;
    const [shared] = yield* sql<{ readonly shared_at: string }>`
      SELECT shared_at FROM j5_a2a_shared_thread WHERE thread_id = ${message.threadId}
    `;
    return typedByFirstOwner({
      message_id: message.id,
      created_by: message.createdBy,
      creation_source: message.creationSource,
      created_at: DateTime.formatIso(message.createdAt),
      scheduled_task_id: null,
      sender_thread_id: null,
      shared_at: shared?.shared_at ?? null,
    });
  });
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* SecureRandom.SecureRandom;
  const personas = yield* makeAgentPersonaLibrary;
  const registry = yield* ProviderRegistry;
  const memberModels = yield* CrewMemberModels;
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
  const readDefinitionText = Effect.fn("PlaybookStore.readDefinitionText")(
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
      return yield* fs.readFileString(realFile);
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
  const parseDefinitionText = (text: string, unreadable?: string) =>
    decodePlaybookDocument(text).pipe(
      Effect.mapError((error) =>
        playbookError(
          error.code,
          unreadable ?? `Cannot read this playbook. Fix its YAML and retry. ${error.message}`,
          error.availableStepIds,
        ),
      ),
    );
  const readDefinitionDocument = Effect.fn("PlaybookStore.readDefinitionDocument")(function* (
    definitionPath: string,
    unreadable?: string,
  ) {
    return yield* parseDefinitionText(
      yield* readDefinitionText(definitionPath, unreadable),
      unreadable,
    );
  });
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
    return yield* requests.transaction(
      Effect.gen(function* () {
        const timestamp = yield* now;
        const rows = yield* sql<RunRow>`UPDATE j5_playbook_run
        SET status = 'cancelled', cancel_reason = ${reason}, updated_at = ${timestamp}
        WHERE owner_thread_id = ${owner} AND status = 'active'
        ${runId === undefined ? sql`` : sql`AND run_id = ${runId}`}
        RETURNING *`;
        for (const row of rows) {
          yield* skipPending(row.run_id, timestamp);
          yield* closeCheckpoint(row.run_id, timestamp);
          if (row.persona_request_id) yield* requests.close(row.persona_request_id, timestamp);
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
    {
      definition: _snapshot,
      requiredPersonas: _statuses,
      personaBlockReason,
      ...run
    }: StoredPlaybookRun,
    definition: PlaybookDefinition | null,
    replayed = false,
  ): PlaybookStepResponse => {
    const index = definition?.steps.findIndex((step) => step.id === run.currentStepId) ?? -1;
    return {
      ...run,
      title: definition?.title ?? path.basename(run.definitionPath, ".yaml"),
      description: definition?.description ?? "",
      steps: definition?.steps.map(({ id, title }) => ({ id, title })) ?? [],
      issue: null,
      position: index < 0 ? null : index + 1,
      total: definition?.steps.length ?? 0,
      currentStep: personaBlockReason === null ? (definition?.steps[index] ?? null) : null,
      replayed,
    };
  };
  const view = Effect.fn("PlaybookStore.view")(function* (
    run: StoredPlaybookRun,
    replayed = false,
  ) {
    return {
      ...present(run, run.definition, replayed),
      ...(run.requiredPersonas === null ? {} : { requiredPersonas: run.requiredPersonas }),
      checkpoint: yield* currentCheckpoint(run),
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
  const threadPersona = Effect.fn("PlaybookStore.threadPersona")(function* (threadId: ThreadId) {
    const rows = yield* sql<{
      project_id: string;
      runtime_mode: string;
      assignment_json: string | null;
    }>`
      SELECT project_id, runtime_mode, json_extract(payload_json, '$.agentPersonaAssignment') AS assignment_json
      FROM orchestration_v2_projection_threads
      WHERE thread_id = ${threadId} AND archived_at IS NULL AND deleted_at IS NULL`;
    const row = rows[0];
    return row === undefined
      ? undefined
      : {
          projectId: ProjectId.make(row.project_id),
          runtimeMode: decodeRuntimeMode(row.runtime_mode),
          ...(row.assignment_json === null
            ? {}
            : { agentPersonaAssignment: decodeAssignment(row.assignment_json) }),
        };
  });
  const assessSteps = Effect.fn("PlaybookStore.assessSteps")(function* (
    steps: ReadonlyArray<PlaybookStep>,
    owner?: ThreadId,
  ) {
    const ids = [...new Set(namedSteps(steps).map(({ persona }) => persona))];
    return yield* assessRequiredPersonas(
      ids,
      personas,
      registry,
      memberModels,
      owner === undefined || ids.length === 0 ? undefined : yield* threadPersona(owner),
    );
  });
  type Assessment = Effect.Success<ReturnType<typeof assessSteps>>;
  const matchingAssessment = (steps: ReadonlyArray<PlaybookStep>, prepared?: Assessment) => {
    const ids = new Set(namedSteps(steps).map(({ persona }) => persona));
    const assessment = prepared ?? { statuses: [], picks: [] };
    return ids.size === assessment.statuses.length &&
      assessment.statuses.every(({ persona }) => ids.has(persona))
      ? assessment
      : undefined;
  };
  const assertRequiredHolder = Effect.fn("PlaybookStore.assertRequiredHolder")(function* (
    step: PlaybookStep | undefined,
    threadId: ThreadId | null,
    checkAvailability: boolean,
    statuses?: typeof PlaybookRequiredPersonas.Type,
  ) {
    if (step?.persona === undefined) return;
    const persona = step.persona;
    if (checkAvailability) {
      const status = (
        statuses ??
        (yield* assessRequiredPersonas([persona], personas, registry, memberModels)).statuses
      ).find((entry) => entry.persona === persona);
      if (status?.status === "unavailable")
        return yield* playbookError(
          "persona_unavailable",
          `Step "${step.id}" requires persona "${persona}". ${status.reason}`,
        );
    }
    const thread = threadId === null ? undefined : yield* threadPersona(threadId);
    if (thread?.agentPersonaAssignment?.personaId !== persona)
      return yield* playbookError(
        "required_persona_mismatch",
        `Step "${step.id}" requires a holder running persona "${persona}". Assign it to a matching participant.`,
      );
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
        path.basename(recordedPath, ".yaml") !== name.replace(/\.yaml$/, "")
      )
        return yield* playbookError(
          "request_conflict",
          "This client_request_id belongs to a different operation. Use a new key for a new operation.",
        );
      // Before runtime assignees, starts could include the originating Crew ID.
      // Preserve that legacy shape only for retries of the original unassigned start.
      const legacyRequest =
        request.length === 3 && typeof request[2] === "string" ? rows[0].request_json : undefined;
      return { definitionPath: recordedPath, legacyRequest };
    }
    return { ...(yield* definitionPathFor(workspaceRoot, name)), legacyRequest: undefined };
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
    const { definitionPath, legacyRequest } = yield* startDefinitionPathFor(
      owner,
      workspaceRoot,
      name,
      key,
    );
    const request =
      assignee === undefined
        ? (legacyRequest ?? encodeRequest(["start", definitionPath]))
        : encodeRequest(["start", definitionPath, null, assignee]);
    return yield* Effect.gen(function* () {
      yield* cancelOrphans();
      const previous = yield* replay(owner, key, request);
      if (previous) return yield* view(previous, true);
      // Read once, even when a named persona needs assessment before insertion.
      const source = yield* Effect.result(readDefinitionText(definitionPath));
      const persist = Effect.fn("PlaybookStore.persistStart")(function* (prepared?: Assessment) {
        return yield* Effect.gen(function* () {
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
          if (source._tag === "Failure") return yield* source.failure;
          const { definition } = yield* parseDefinitionText(source.success);
          const firstStep = definition.steps[0]!;
          const assessment = matchingAssessment(definition.steps, prepared);
          if (assessment === undefined) return { needsAssessment: definition.steps };
          const { statuses, picks } = assessment;
          const target = yield* resolveHolder(owner, assignee);
          const checked = yield* Effect.result(
            assertRequiredHolder(firstStep, target.threadId, true, statuses),
          );
          const holder = checked._tag === "Success" ? target : null;
          const timestamp = yield* now;
          const personaRequestId = picks.length
            ? PLAYBOOK_PERSONA_EXCHANGE_PREFIX + (yield* crypto.uuidV4().pipe(Effect.orDie))
            : null;
          const run: StoredPlaybookRun = {
            ...(personaRequestId ? { personaRequestId } : {}),
            definition,
            requiredPersonas: statuses,
            personaBlockReason: checked._tag === "Failure" ? checked.failure.message : null,
            cancelReason: null,
            revisionCount: 0,
            latestRevision: null,
            runId: yield* crypto.uuidV4().pipe(Effect.orDie),
            ownerThreadId: owner,
            definitionPath,
            currentStepId: firstStep.id,
            holderParticipantId: holder?.participantId ?? null,
            holderThreadId: holder?.threadId ?? null,
            assignedByParticipantId: holder?.assignedBy ?? null,
            status: "active",
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          yield* sql`INSERT INTO j5_playbook_run (run_id, owner_thread_id, definition_path, current_step_id, status, created_at, updated_at, definition_json,
            holder_participant_id, holder_thread_id, assigned_by_participant_id, start_event_sequence, required_personas_json, persona_block_reason, persona_request_id, persona_picks_json)
          VALUES (${run.runId}, ${owner}, ${definitionPath}, ${run.currentStepId}, ${run.status}, ${timestamp}, ${timestamp}, ${encodeDefinition(definition)},
            ${run.holderParticipantId}, ${run.holderThreadId}, ${run.assignedByParticipantId},
            (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events), ${encodeRequiredPersonas(statuses)}, ${run.personaBlockReason}, ${personaRequestId}, ${personaRequestId ? encodeJson(picks) : null})`;
          if (holder !== null) yield* land(run.runId, key, run.currentStepId, timestamp, holder);
          const limited = statuses.flatMap((entry) =>
            entry.status === "limited" ? [`• ${entry.persona}: ${entry.limits}`] : [],
          );
          if (personaRequestId)
            yield* requests.open({
              requestId: personaRequestId,
              threadId: owner,
              title: "Playbook persona picks",
              body: `Approve these persona picks for this run. The owner's launches of these personas can use their configured models and access.\n\n${limited.join("\n")}`,
              at: timestamp,
            });
          yield* remember(owner, key, request, run.runId);
          return { run, replayed: false };
        }).pipe(requests.transaction);
      });
      // Release the writer for catalog and provider reads. The next transaction uses the same YAML.
      let result = yield* persist();
      if (result.needsAssessment !== undefined) {
        result = yield* persist(yield* assessSteps(result.needsAssessment, owner));
        if (result.needsAssessment !== undefined)
          return yield* playbookError(
            "step_conflict",
            "The playbook's required personas changed during start. Read the playbook and retry.",
          );
      }
      if (result.replayed) return yield* view(result.run, true);
      const definition = result.run.definition!;
      yield* recordAnalytics("j5.playbook.run.started", {
        stepCount: definition.steps.length,
        stepsWithPersona: definition.steps.filter((step) => step.persona !== undefined).length,
        crewBound: false,
      });
      return yield* view(result.run);
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
      const persist = Effect.fn("PlaybookStore.persistMutation")(function* (prepared?: Assessment) {
        return yield* Effect.gen(function* () {
          const previous = yield* replay(owner, input.client_request_id, request);
          if (previous) return { run: previous, replayed: true };
          const run = yield* readRun(owner, input.runId);
          let definition = run.definition;
          if (definition === null && input.operation !== "cancel")
            return yield* playbookError(
              "invalid_snapshot",
              "This run has no readable playbook copy. Cancel it and start a new run.",
            );
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
            const previouslyPassed = new Set(
              previousSteps
                .slice(
                  0,
                  previousSteps.findIndex((step) => step.id === run.currentStepId),
                )
                .filter((step) => step.approval === "required")
                .map((step) => step.id),
            );
            if (
              definition.steps
                .slice(0, ids.indexOf(currentStepId))
                .some((step) => step.approval === "required" && !previouslyPassed.has(step.id))
            )
              return yield* playbookError(
                "invalid_definition",
                "The revision would skip a required approval.",
              );
          } else if (definition) {
            const ids = definition.steps.map((step) => step.id);
            const index = ids.indexOf(run.currentStepId);
            if (index < 0)
              return yield* playbookError("invalid_snapshot", "The run has no current step.");
            if (input.operation === "complete") {
              if (definition.steps.slice(index + 1).some((step) => step.approval === "required"))
                return yield* playbookError(
                  "step_boundary",
                  "A later step requires approval before this run can complete.",
                );
              status = "completed";
            } else if (input.operation !== "assign") {
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
          const oldStep = run.definition?.steps.find((step) => step.id === run.currentStepId);
          const newStep = definition?.steps.find((step) => step.id === currentStepId);
          const personaChanged = oldStep?.persona !== newStep?.persona;
          if (
            input.operation === "revise" &&
            currentStepId === run.currentStepId &&
            input.assignee !== undefined &&
            !personaChanged
          )
            return yield* playbookError(
              "invalid_assignee",
              "A revision that keeps the current step and persona cannot change its holder. Use j5_playbook_assign.",
            );
          const revised =
            input.operation === "revise" && encodeJson(oldStep) !== encodeJson(newStep);
          if (input.operation === "next" || input.operation === "complete")
            yield* assertRequiredHolder(oldStep, run.holderThreadId, false);
          const updatedAt = yield* now;
          if (input.operation === "next" || input.operation === "complete") {
            const step = run.definition?.steps.find((step) => step.id === run.currentStepId);
            if (step?.approval === "required") {
              const checkpoint = yield* currentCheckpoint(run);
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
                    yield* closeCheckpoint(run.runId, updatedAt);
                  const requestId = playbookRequestId(yield* crypto.uuidV4().pipe(Effect.orDie));
                  yield* requests.open({
                    requestId,
                    threadId: owner,
                    title: `Approve playbook step: ${step.title}`,
                    body: summary,
                    at: updatedAt,
                  });
                  yield* sql`UPDATE j5_playbook_run SET checkpoint_request_id = ${requestId}, checkpoint_summary = ${summary} WHERE run_id = ${run.runId}`;
                }
                return { run, replayed: false, approvalPending: true };
              }
            }
          }
          const holder =
            input.operation === "next" ||
            input.operation === "back" ||
            input.operation === "assign" ||
            (input.operation === "revise" &&
              (currentStepId !== run.currentStepId ||
                (revised &&
                  (run.personaBlockReason !== null ||
                    (personaChanged && input.assignee !== undefined)))))
              ? yield* resolveHolder(owner, input.assignee)
              : null;
          const assessmentSteps =
            input.operation === "revise"
              ? input.steps
              : holder !== null && newStep !== undefined
                ? [newStep]
                : [];
          const revisedPersonas = matchingAssessment(assessmentSteps, prepared);
          if (revisedPersonas === undefined) return { needsAssessment: assessmentSteps };
          if (holder !== null || revised) {
            const statuses = revisedPersonas.statuses;
            yield* assertRequiredHolder(
              newStep,
              holder?.threadId ?? run.holderThreadId,
              true,
              statuses,
            );
          }

          if (input.operation !== "assign" && (input.operation !== "revise" || revised))
            yield* closeCheckpoint(run.runId, updatedAt);
          if (status !== "active" && run.personaRequestId)
            yield* requests.close(run.personaRequestId, updatedAt);
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
            if (
              holder === null &&
              currentStepId === run.currentStepId &&
              run.holderThreadId !== owner
            ) {
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
            yield* sql`UPDATE j5_playbook_run SET definition_json = ${encodeDefinition(definition!)}, required_personas_json = ${encodeRequiredPersonas(revisedPersonas.statuses)}, revision_count = ${revisionCount}, latest_revision_json = ${encodeRevision(latestRevision)} WHERE run_id = ${run.runId}`;
          }
          yield* sql`UPDATE j5_playbook_run SET current_step_id = ${currentStepId}, status = ${status}, updated_at = ${updatedAt},
            cancel_reason = ${input.operation === "cancel" ? "agent_cancelled" : (run.cancelReason ?? null)},
            persona_block_reason = ${holder === null ? run.personaBlockReason : null},
            holder_participant_id = ${holder?.participantId ?? run.holderParticipantId},
            holder_thread_id = ${holder?.threadId ?? run.holderThreadId},
            assigned_by_participant_id = ${holder?.assignedBy ?? run.assignedByParticipantId}
          WHERE run_id = ${run.runId} AND owner_thread_id = ${owner}`;
          if (
            input.operation === "assign" ||
            (input.operation === "revise" && holder !== null) ||
            status !== "active"
          )
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
              requiredPersonas:
                input.operation === "revise" ? revisedPersonas.statuses : run.requiredPersonas,
              currentStepId,
              status,
              updatedAt,
              revisionCount,
              latestRevision,
              personaBlockReason: holder === null ? run.personaBlockReason : null,
              holderParticipantId: holder?.participantId ?? run.holderParticipantId,
              holderThreadId: holder?.threadId ?? run.holderThreadId,
              assignedByParticipantId: holder?.assignedBy ?? run.assignedByParticipantId,
            },
            replayed: false,
          };
        }).pipe(requests.transaction);
      });
      let result = yield* persist();
      if (result.needsAssessment !== undefined) {
        result = yield* persist(
          yield* assessSteps(
            result.needsAssessment,
            input.operation === "revise" ? owner : undefined,
          ),
        );
        if (result.needsAssessment !== undefined)
          return yield* playbookError(
            "step_conflict",
            "The run's required personas changed. Retrieve j5_playbook_current and retry.",
          );
      }
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
  type ProgressRow = RunRow & {
    title: string | null;
    description: string | null;
    steps_json: string;
  };
  // SQLite JSON functions throw on malformed text, including scalar step entries.
  const displayDefinition = sql`CASE WHEN json_valid(definition_json) THEN definition_json END`;
  const progressColumns = sql`run_id, owner_thread_id, definition_path, current_step_id,
    holder_participant_id, holder_thread_id, assigned_by_participant_id, status, created_at,
    updated_at, crew_instance_id, cancel_reason, holder_stop_json, revision_count, latest_revision_json,
    NULL AS definition_json, checkpoint_summary, required_personas_json, persona_request_id, persona_block_reason,
    json_extract(${displayDefinition}, '$.title') AS title, json_extract(${displayDefinition}, '$.description') AS description,
    (SELECT json_group_array(CASE WHEN type = 'object' THEN json_object('id', value ->> '$.id', 'title', value ->> '$.title') END)
     FROM json_each(${displayDefinition}, '$.steps')) AS steps_json`;
  const progressRows = Effect.fn("j5.playbooks.playbookStore.progressRows")(function* (
    rows: ReadonlyArray<ProgressRow>,
  ) {
    if (rows.length === 0) return [];
    const details = yield* sql<{
      run_id: string;
      blocked: number;
      waiting_for_approval: number;
      holder_name: string | null;
    }>`SELECT run.run_id,
      (run.status = 'active' AND COALESCE(checkpoint.status = 'open', 0)) AS waiting_for_approval,
      (run.status = 'active' AND (run.persona_block_reason IS NOT NULL OR EXISTS (
        SELECT 1 FROM j5_a2a_membership membership
        JOIN j5_a2a_human_inbox inbox ON inbox.project_id = membership.project_id
          AND inbox.sender_id = membership.participant_id
        WHERE membership.thread_id = run.owner_thread_id AND inbox.status = 'open'
          AND inbox.exchange_id IS NOT run.checkpoint_request_id
      ))) AS blocked,
      CASE WHEN run.holder_thread_id <> run.owner_thread_id THEN holder.title END AS holder_name
      FROM j5_playbook_run run
      LEFT JOIN orchestration_v2_projection_threads holder ON holder.thread_id = run.holder_thread_id
      LEFT JOIN j5_a2a_exchange checkpoint ON checkpoint.exchange_id = run.checkpoint_request_id
      WHERE run.run_id IN ${sql.in(rows.map((row) => row.run_id))}`;
    const byRun = new Map(details.map((detail) => [detail.run_id, detail]));
    return rows.map((row) => {
      const run = fromRow(row);
      const {
        currentStep: _prompt,
        replayed: _replayed,
        ...progress
      } = present(run, run.definition);
      const steps =
        typeof row.title === "string" && typeof row.description === "string"
          ? Option.getOrElse(readStepLabels(row.steps_json), () => [])
          : [];
      const index = steps.findIndex((step) => step.id === run.currentStepId);
      const detail = byRun.get(run.runId)!;
      return {
        ...progress,
        title: steps.length ? (row.title ?? progress.title) : progress.title,
        description: steps.length ? (row.description ?? "") : "",
        steps,
        position: index < 0 ? null : index + 1,
        total: steps.length,
        blocked: Boolean(detail.blocked),
        waitingForApproval: Boolean(detail.waiting_for_approval),
        holderName: detail.holder_name,
      };
    });
  });
  const listForThread = Effect.fn("PlaybookStore.listForThread")(function* (owner: ThreadId) {
    yield* cancelOrphans();
    const rows =
      yield* sql<ProgressRow>`SELECT ${progressColumns} FROM j5_playbook_run WHERE owner_thread_id = ${owner}
      ORDER BY (status = 'active') DESC, rowid DESC LIMIT 20`;
    const runs = yield* progressRows(rows);
    return {
      runs: runs.map((run, index) => {
        const summary = rows[index]?.checkpoint_summary;
        return summary ? { ...run, checkpointSummary: summary } : run;
      }),
    };
  }, Effect.mapError(storageError));
  const listAll = Effect.fn("PlaybookStore.listAll")(function* (input: PlaybookRunsRequest) {
    yield* cancelOrphans();
    const filter = input.status === "active" ? sql`status = 'active'` : sql`1 = 1`;
    const counts = yield* sql<{
      total: number;
    }>`SELECT COUNT(*) AS total FROM j5_playbook_run WHERE ${filter}`;
    const rows =
      yield* sql<ProgressRow>`SELECT ${progressColumns} FROM j5_playbook_run WHERE ${filter}
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
      // The daemon subscribes at the current high-water mark. An unarchive can
      // already have hidden a missed archive in the owner's projection.
      const missed = yield* sql<{
        run_id: string;
        owner_thread_id: string;
        event_type: "thread.archived" | "thread.deleted";
      }>`SELECT run.run_id, run.owner_thread_id, event.event_type
        FROM j5_playbook_run run
        JOIN orchestration_events event ON event.sequence = (
          SELECT lifecycle.sequence FROM orchestration_events lifecycle
          WHERE lifecycle.aggregate_kind = 'thread' AND lifecycle.stream_id = run.owner_thread_id
            AND lifecycle.sequence > run.start_event_sequence
            AND (run.start_event_sequence <> 0 OR lifecycle.occurred_at >= run.created_at)
            AND lifecycle.event_type IN ('thread.archived', 'thread.deleted')
            AND lifecycle.application_event_version = 2
          ORDER BY lifecycle.sequence LIMIT 1)
        WHERE run.status = 'active'`;
      for (const row of missed)
        yield* cancelOwner(
          ThreadId.make(row.owner_thread_id),
          row.event_type === "thread.archived" ? "owner_archived" : "owner_deleted",
          row.run_id,
        );
      yield* cancelOrphans();
      return yield* sql<{
        runId: string;
      }>`SELECT run_id AS runId FROM j5_playbook_run WHERE status = 'cancelled' AND holder_stop_json IS NULL AND cancel_reason IN ('owner_archived', 'owner_deleted', 'agent_cancelled')`;
    },
    Effect.mapError(storageError),
  );
  const activeRunSummaries = Effect.fn("PlaybookStore.activeRunSummaries")(function* (
    ownerThreadIds: ReadonlyArray<ThreadId>,
  ) {
    if (ownerThreadIds.length === 0) return [];
    const rows = yield* sql<
      Pick<
        RunRow,
        | "run_id"
        | "owner_thread_id"
        | "current_step_id"
        | "holder_participant_id"
        | "holder_thread_id"
        | "persona_block_reason"
      > & {
        delivery_outcome: PlaybookLanding["outcome"];
        position: number;
        total: number;
        step_title: string;
      }
    >`SELECT run.run_id, run.owner_thread_id, run.current_step_id, run.holder_participant_id,
      run.holder_thread_id, run.persona_block_reason, delivery.outcome AS delivery_outcome,
      COALESCE(step.key + 1, 0) AS position,
      COALESCE(json_array_length(${displayDefinition}, '$.steps'), 0) AS total,
      COALESCE(step.value ->> '$.title', run.current_step_id) AS step_title
      FROM j5_playbook_run run
      LEFT JOIN json_each(${displayDefinition}, '$.steps') step ON CASE WHEN step.type = 'object' THEN step.value ->> '$.id' END = run.current_step_id
      LEFT JOIN j5_playbook_step_delivery delivery ON delivery.rowid = (
        SELECT landing.rowid FROM j5_playbook_step_delivery landing
        WHERE landing.run_id = run.run_id AND landing.step_id = run.current_step_id
        ORDER BY landing.landed_at DESC, landing.rowid DESC LIMIT 1
      )
      WHERE run.status = 'active' AND run.owner_thread_id IN ${sql.in([...ownerThreadIds])}`;
    return rows.map((row) => {
      return {
        ownerThreadId: ThreadId.make(row.owner_thread_id),
        runId: row.run_id,
        position: row.position,
        total: row.total,
        stepId: row.current_step_id,
        stepTitle: row.step_title,
        holderParticipantId: row.holder_participant_id,
        state:
          row.persona_block_reason !== null
            ? ("blocked" as const)
            : row.holder_thread_id === row.owner_thread_id
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
    refreshRequestStatus: bumpRevision,
    sources: () =>
      library.sources(undefined).pipe(
        Effect.map((folders) => ({
          folders: folders.map(({ source, path, issue }) => ({ source, path, issue })),
        })),
      ),
    authorizeScheduledStart: (taskId: string, name: string) =>
      authorizeScheduledStart(taskId, name).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    saveDefinition: (input: PlaybookSaveRequest) =>
      library.save(input).pipe(permit.withPermits(1), Effect.tap(bumpRevision)),
    saveDefinitionFromTurn: Effect.fn("PlaybookStore.saveDefinitionFromTurn")(
      function* (
        message: OrchestrationV2ConversationMessage | undefined,
        input: PlaybookSaveRequest,
      ) {
        if (!(yield* initiatedByOwner(message))) {
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
    assertRequiredHolder,
    landing,
    latestLanding,
    pendingLandings,
    resolveLanding,
    cancelOwner,
    claimHolderStop,
    recordHolderStop,
    unreconciledCancellations,
    ownerLifecycleRuns,
    activeRunSummaries,
  };
});

export const makePlaybookStore = buildPlaybookStore.pipe(Effect.provide(ledgerLayer));

export class PlaybookStore extends Context.Service<
  PlaybookStore,
  Effect.Success<typeof makePlaybookStore>
>()("t3/j5/playbooks/PlaybookStore") {}
export const playbookStoreLayer = Layer.effect(PlaybookStore, buildPlaybookStore).pipe(
  Layer.provide(ledgerLayer),
);
