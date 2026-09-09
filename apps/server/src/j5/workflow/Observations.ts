import { BoardPage, TimelinePage, type TimelineEntry } from "@j5/workflow-contracts/observability";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeRunFilter } from "./SidebarRead.ts";
import { WorkflowError } from "./Store.ts";

export interface WorkflowObservation {
  readonly runId: string;
  readonly revision: number;
  readonly source: "trigger" | "receipt" | "history";
  readonly recordedAt: string | null;
  readonly eventType: string | null;
  readonly eventActionId: string | null;
  readonly eventGateRevision: number | null;
  readonly eventArtifactHash: string | null;
  readonly decision: "approve" | "request_changes" | "cancel" | null;
  readonly actor: string | null;
  readonly eventCause: string | null;
  readonly phase: string | null;
  readonly status: string | null;
  readonly visit: number | null;
  readonly gateRevision: number | null;
  readonly gateArtifactHash: string | null;
  readonly failureCategory: NonNullable<TimelineEntry["failureCategory"]> | null;
  readonly relevantActionId: string | null;
  readonly recovery: string | null;
  readonly stateCause: string | null;
  readonly approvalsCount: number | null;
  readonly eventActionStatus: string | null;
  readonly eventResultArtifactId: string | null;
  readonly eventActionIdentity: string | null;
}

export interface ObservedAction {
  readonly id: string;
  readonly revision: number;
  readonly phase: string;
  readonly task: string;
  readonly attempt: number;
  readonly kind: "agent" | "code";
  readonly creationVisit: number | null;
}

const optional = <K extends string, V>(key: K, value: V | null): { [P in K]?: V } =>
  value === null ? {} : ({ [key]: value } as { [P in K]: V });

const actionFields = (action: ObservedAction, observation?: WorkflowObservation) => ({
  actionId: action.id,
  task: action.task,
  attempt: action.attempt,
  actionKind: action.kind,
  ...(() => {
    const identity = observation?.eventActionIdentity;
    if (!identity) return {};
    const parts = identity.split("/");
    return parts.length === 2 && parts[0] && parts[1] ? { threadId: parts[0] } : {};
  })(),
});

const entry = (
  revision: number,
  ordinal: number,
  kind: TimelineEntry["kind"],
  observation: WorkflowObservation,
  fields: Omit<Partial<TimelineEntry>, "id" | "kind" | "partial"> = {},
  partial = false,
): TimelineEntry => ({
  id: `${revision}:${ordinal}`,
  kind,
  phase: fields.phase === undefined ? observation.phase : fields.phase,
  visit: fields.visit === undefined ? observation.visit : fields.visit,
  ...fields,
  partial,
});

const changedBlockedState = (previous: WorkflowObservation, current: WorkflowObservation) =>
  current.status === "blocked" &&
  (previous?.status !== "blocked" ||
    previous.failureCategory !== current.failureCategory ||
    previous.stateCause !== current.stateCause ||
    previous.relevantActionId !== current.relevantActionId);

export function deriveTimelineRevisions(
  observations: ReadonlyArray<WorkflowObservation>,
  actions: ReadonlyArray<ObservedAction>,
  verdicts: ReadonlyMap<string, string | null>,
  selectedRevisions: ReadonlySet<number>,
): TimelinePage["revisions"] {
  const ordered = [...observations].sort((left, right) => left.revision - right.revision);
  const actionById = new Map(actions.map((action) => [action.id, action]));
  const createdByRevision = new Map<number, ObservedAction[]>();
  for (const action of actions) {
    const atRevision = createdByRevision.get(action.revision) ?? [];
    atRevision.push(action);
    createdByRevision.set(action.revision, atRevision);
  }
  for (const created of createdByRevision.values())
    created.sort(
      (left, right) =>
        left.task.localeCompare(right.task) ||
        left.attempt - right.attempt ||
        left.id.localeCompare(right.id),
    );

  const revisions = [];
  for (let index = 0; index < ordered.length; index++) {
    const observation = ordered[index]!;
    if (!selectedRevisions.has(observation.revision)) continue;
    const previous = ordered[index - 1];
    const knownPrevious =
      previous !== undefined && previous.source !== "history" && previous.status !== null;
    const created = createdByRevision.get(observation.revision) ?? [];
    const eventAction = observation.eventActionId
      ? actionById.get(observation.eventActionId)
      : undefined;
    const entries: TimelineEntry[] = [];
    let ordinal = 0;
    const add = (
      kind: TimelineEntry["kind"],
      fields: Omit<Partial<TimelineEntry>, "id" | "kind" | "partial"> = {},
      partial = false,
    ) => entries.push(entry(observation.revision, ordinal++, kind, observation, fields, partial));
    const generic = (partial = true) =>
      add("event", { eventType: observation.eventType ?? "unknown" }, partial);

    if (observation.source === "history") {
      generic();
    } else if (observation.failureCategory === "definition_mismatch") {
      add("blocked", {
        ...optional("failureCategory", observation.failureCategory),
        ...optional("cause", observation.stateCause),
      });
    } else {
      let commandSupported = false;
      if (observation.eventType === "result" && eventAction) {
        const replacement = created.find(
          (candidate) =>
            candidate.phase === eventAction.phase &&
            candidate.task === eventAction.task &&
            candidate.attempt === eventAction.attempt + 1,
        );
        if (replacement && observation.eventActionStatus === "cancelled") {
          add(
            "action_correction",
            {
              phase: replacement.phase,
              visit: replacement.creationVisit,
              ...actionFields(replacement),
              replacesActionId: eventAction.id,
            },
            replacement.creationVisit === null,
          );
          commandSupported = true;
        } else if (
          observation.eventActionStatus === "completed" &&
          observation.eventResultArtifactId !== null &&
          verdicts.has(observation.eventResultArtifactId)
        ) {
          add(
            "action_completed",
            {
              phase: eventAction.phase,
              visit: eventAction.creationVisit,
              ...actionFields(eventAction, observation),
              ...optional("verdict", verdicts.get(observation.eventResultArtifactId) ?? null),
            },
            eventAction.creationVisit === null,
          );
          commandSupported = true;
        } else if (
          observation.relevantActionId === eventAction.id &&
          ["action_deadline_expired", "invalid_action_output"].includes(
            observation.failureCategory ?? "",
          )
        ) {
          add(
            "action_failed",
            {
              phase: eventAction.phase,
              visit: eventAction.creationVisit,
              ...actionFields(eventAction, observation),
              ...optional("failureCategory", observation.failureCategory),
              ...optional("cause", observation.stateCause),
            },
            eventAction.creationVisit === null,
          );
          commandSupported = true;
        }
      } else if (
        observation.eventType === "block" &&
        eventAction &&
        observation.eventActionStatus === "blocked" &&
        observation.relevantActionId === eventAction.id &&
        observation.status === "blocked"
      ) {
        add(
          "action_failed",
          {
            phase: eventAction.phase,
            visit: eventAction.creationVisit,
            ...actionFields(eventAction, observation),
            ...optional("failureCategory", observation.failureCategory),
            ...optional("cause", observation.stateCause),
          },
          eventAction.creationVisit === null,
        );
        commandSupported = true;
      } else if (observation.eventType === "decision") {
        const applied =
          previous !== undefined &&
          previous.approvalsCount !== null &&
          observation.approvalsCount === previous.approvalsCount + 1 &&
          previous.gateRevision === observation.eventGateRevision &&
          previous.gateArtifactHash === observation.eventArtifactHash &&
          observation.decision !== null;
        if (applied) {
          add("decision", {
            phase: previous.phase,
            visit: previous.visit,
            gateRevision: observation.eventGateRevision!,
            artifactHash: observation.eventArtifactHash!,
            decision: observation.decision!,
            ...optional("actor", observation.actor),
          });
          if (observation.decision === "cancel")
            add("cancel_requested", { phase: previous.phase, visit: previous.visit });
          commandSupported = true;
        }
      } else if (
        observation.eventType === "edit_gate" &&
        observation.status === "waiting_approval" &&
        observation.gateRevision === observation.revision &&
        observation.gateArtifactHash !== null
      ) {
        add("gate_revised", {
          gateRevision: observation.gateRevision,
          artifactHash: observation.gateArtifactHash,
          ...optional("actor", observation.actor),
        });
        commandSupported = true;
      } else if (
        ["recover", "retry"].includes(observation.eventType ?? "") &&
        previous?.status === "blocked" &&
        ["running", "waiting_approval"].includes(observation.status ?? "")
      ) {
        add("recovered");
        commandSupported = true;
      } else if (
        ["restart_phase", "retry_restart"].includes(observation.eventType ?? "") &&
        observation.status === "restarting"
      ) {
        add("restart_requested");
        commandSupported = true;
      } else if (
        observation.eventType === "restart_cleanup_failed" &&
        observation.status === "blocked" &&
        observation.failureCategory === "restart_cleanup_failed"
      ) {
        add("restart_cleanup_failed", { ...optional("cause", observation.stateCause) });
        commandSupported = true;
      } else if (observation.eventType === "restart_ready" && observation.status === "running") {
        add("restart_ready");
        commandSupported = true;
      } else if (observation.eventType === "cancel" && observation.status === "cancelling") {
        add("cancel_requested");
        commandSupported = true;
      } else if (observation.eventType === "invalidate" && knownPrevious) {
        add("invalidated", { ...optional("cause", observation.eventCause) });
        commandSupported = true;
      }

      if (
        observation.phase !== null &&
        observation.visit !== null &&
        ((previous === undefined &&
          observation.revision === 1 &&
          observation.visit > 0 &&
          observation.status !== "blocked") ||
          (knownPrevious &&
            (previous.phase !== observation.phase || previous.visit !== observation.visit)))
      ) {
        add("phase_entered", {
          ...(previous?.phase === null || previous?.phase === undefined
            ? {}
            : { fromPhase: previous.phase }),
          ...(previous?.visit === null || previous?.visit === undefined
            ? {}
            : { fromVisit: previous.visit }),
        });
      }

      const gateWasEstablished =
        observation.gateRevision !== null &&
        observation.gateArtifactHash !== null &&
        ((previous === undefined && observation.revision === 1) ||
          (knownPrevious &&
            (previous.gateRevision !== observation.gateRevision ||
              previous.gateArtifactHash !== observation.gateArtifactHash)));
      if (gateWasEstablished && observation.eventType !== "edit_gate")
        add("gate_opened", {
          gateRevision: observation.gateRevision!,
          artifactHash: observation.gateArtifactHash!,
        });

      for (const action of created) {
        add(
          "action_queued",
          {
            phase: action.phase,
            visit: action.creationVisit,
            ...actionFields(action),
          },
          action.creationVisit === null,
        );
      }

      if (knownPrevious && changedBlockedState(previous, observation))
        add("blocked", {
          ...optional("failureCategory", observation.failureCategory),
          ...optional("cause", observation.stateCause),
        });
      if (knownPrevious && previous.status !== "completed" && observation.status === "completed")
        add("completed");
      if (knownPrevious && previous.status !== "cancelled" && observation.status === "cancelled") {
        add("cancelled");
        if (observation.eventType === "cancelled") commandSupported = true;
      }

      if (entries.length === 0 || (!commandSupported && observation.eventType !== "enter"))
        generic();
    }
    revisions.push({
      revision: observation.revision,
      recordedAt: observation.recordedAt,
      partial: entries.some((item) => item.partial),
      entries,
    });
  }
  return revisions.sort((left, right) => right.revision - left.revision);
}

const decodeBoard = Schema.decodeUnknownEffect(BoardPage);
const decodeTimeline = Schema.decodeUnknownEffect(TimelinePage);
const observationColumns = `run_id AS runId, revision, source,
  CASE WHEN recorded_at IS NULL THEN NULL
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at / 1000.0, 'unixepoch') END AS recordedAt,
  event_type AS eventType, event_action_id AS eventActionId,
  event_gate_revision AS eventGateRevision, event_artifact_hash AS eventArtifactHash,
  decision, actor, event_cause AS eventCause, phase, status, visit,
  gate_revision AS gateRevision, gate_artifact_hash AS gateArtifactHash,
  failure_category AS failureCategory, relevant_action_id AS relevantActionId,
  recovery, state_cause AS stateCause, approvals_count AS approvalsCount,
  event_action_status AS eventActionStatus,
  event_result_artifact_id AS eventResultArtifactId,
  event_action_identity AS eventActionIdentity`;

export const readBoard = Effect.fn("Workflow.readBoard")(function* (
  squadronId: string,
  query: string,
  offset: number,
  limit = 24,
  status = "",
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const boundedLimit = Math.min(48, Math.max(1, limit));
      const filter = makeRunFilter(squadronId, query, status);
      const counts = yield* sql.unsafe<{ total: number; waitingApprovalCount: number }>(
        `SELECT count(*) AS total,
          sum(CASE WHEN status='waiting_approval' THEN 1 ELSE 0 END) AS waitingApprovalCount
          FROM j5_workflow_runs${filter.sql}`,
        filter.parameters,
      );
      const rows = yield* sql.unsafe<{
        id: string;
        squadronId: string;
        title: string;
        phase: string;
        status: string;
        revision: number;
        gateRevision: number | null;
        updatedAt: string;
        readVersion: number;
        definitionId: string;
        definitionVersion: number;
        definitionHash: string;
        visit: number | null;
        visits: string;
        failureCategory: string | null;
      }>(
        `SELECT id, squadron_id AS squadronId, substr(title, 1, 240) AS title,
          phase, status, revision, gate_revision AS gateRevision,
          strftime('%Y-%m-%dT%H:%M:%fZ', activity_at / 1000.0, 'unixepoch') AS updatedAt,
          read_version AS readVersion, definition_id AS definitionId,
          definition_version AS definitionVersion, definition_hash AS definitionHash,
          (SELECT CAST(v.value AS INTEGER) FROM json_each(payload, '$.visits') AS v
            WHERE v.key=phase LIMIT 1) AS visit,
          json_extract(payload, '$.visits') AS visits,
          json_extract(payload, '$.failureCategory') AS failureCategory
          FROM j5_workflow_runs${filter.sql}
          ORDER BY status_priority, activity_at DESC, creation_sequence DESC LIMIT ? OFFSET ?`,
        [...filter.parameters, boundedLimit + 1, offset],
      );
      const selected = rows.slice(0, boundedLimit);
      const ids = selected.map((row) => row.id);
      const actions =
        ids.length === 0
          ? []
          : yield* sql.unsafe<{
              runId: string;
              actionId: string;
              phase: string;
              task: string;
              attempt: number;
              actionKind: "agent" | "code";
              actionStatus: string;
              deadline: number;
              threadId: string | null;
              sessionRunId: string | null;
              sessionStatus: string | null;
              requestedAt: string | null;
              completedAt: string | null;
            }>(
              `SELECT a.run_id AS runId, a.id AS actionId, a.phase, a.task, a.attempt,
              a.kind AS actionKind, a.status AS actionStatus, a.deadline,
              CASE WHEN a.kind='agent' AND instr(a.identity, '/')>1
                AND length(substr(a.identity, instr(a.identity, '/')+1))>0
                AND instr(substr(a.identity, instr(a.identity, '/')+1), '/')=0
                THEN substr(a.identity, 1, instr(a.identity, '/')-1) END AS threadId,
              p.run_id AS sessionRunId, p.status AS sessionStatus,
              p.requested_at AS requestedAt, p.completed_at AS completedAt
              FROM j5_workflow_actions AS a
              LEFT JOIN orchestration_v2_projection_runs AS p
                ON a.kind='agent' AND instr(a.identity, '/')>1
                AND instr(substr(a.identity, instr(a.identity, '/')+1), '/')=0
                AND p.thread_id=substr(a.identity, 1, instr(a.identity, '/')-1)
                AND p.run_id=substr(a.identity, instr(a.identity, '/')+1)
              WHERE a.run_id IN (${ids.map(() => "?").join(",")})
                AND a.status IN ('pending','claimed','blocked')
              ORDER BY a.run_id, a.task, a.attempt, a.id`,
              ids,
            );
      const actionsByRun = new Map<string, Array<(typeof actions)[number]>>();
      for (const action of actions) {
        const current = actionsByRun.get(action.runId) ?? [];
        current.push(action);
        actionsByRun.set(action.runId, current);
      }
      return yield* decodeBoard({
        cards: selected.map(({ visits, ...row }) => ({
          ...row,
          visits: JSON.parse(visits) as unknown,
          actions: (actionsByRun.get(row.id) ?? []).map(({ runId: _runId, ...action }) => action),
        })),
        hasMore: rows.length > boundedLimit,
        total: counts[0]?.total ?? 0,
        waitingApprovalCount: counts[0]?.waitingApprovalCount ?? 0,
      });
    }),
  );
});

export const readTimeline = Effect.fn("Workflow.readTimeline")(function* (
  runId: string,
  before: number | null,
  limit = 50,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const heads = yield* sql<{ headRevision: number; readVersion: number }>`SELECT
        revision AS headRevision, read_version AS readVersion FROM j5_workflow_runs WHERE id=${runId}`;
      const head = heads[0];
      if (!head)
        return yield* new WorkflowError({ code: "not_found", detail: `Unknown workflow ${runId}` });
      const boundedLimit = Math.min(100, Math.max(1, limit));
      const rows = yield* sql.unsafe<WorkflowObservation>(
        `SELECT ${observationColumns} FROM j5_workflow_observations
          WHERE run_id=?${before === null ? "" : " AND revision<?"}
          ORDER BY revision DESC LIMIT ?`,
        before === null ? [runId, boundedLimit + 1] : [runId, before, boundedLimit + 1],
      );
      const selected = rows.slice(0, boundedLimit);
      if (selected.length === 0)
        return yield* decodeTimeline({
          runId,
          headRevision: head.headRevision,
          readVersion: head.readVersion,
          revisions: [],
          nextBefore: null,
        });
      const selectedRevisions = new Set(selected.map((row) => row.revision));
      const oldest = selected.at(-1)!.revision;
      const predecessor = yield* sql.unsafe<WorkflowObservation>(
        `SELECT ${observationColumns} FROM j5_workflow_observations
          WHERE run_id=? AND revision<? ORDER BY revision DESC LIMIT 1`,
        [runId, oldest],
      );
      const eventActionIds = selected.flatMap((row) =>
        row.eventActionId ? [row.eventActionId] : [],
      );
      const actionRows = yield* sql.unsafe<
        Omit<ObservedAction, "creationVisit"> & { creationVisit: number | null }
      >(
        `SELECT a.id, a.revision, a.phase, a.task, a.attempt, a.kind,
          o.visit AS creationVisit FROM j5_workflow_actions AS a
          LEFT JOIN j5_workflow_observations AS o
            ON o.run_id=a.run_id AND o.revision=a.revision
          WHERE a.run_id=? AND (
            a.revision IN (${[...selectedRevisions].map(() => "?").join(",")})
            ${eventActionIds.length ? `OR a.id IN (${eventActionIds.map(() => "?").join(",")})` : ""}
          )`,
        [runId, ...selectedRevisions, ...eventActionIds],
      );
      const artifactIds = selected.flatMap((row) =>
        row.eventResultArtifactId ? [row.eventResultArtifactId] : [],
      );
      const verdictRows =
        artifactIds.length === 0
          ? []
          : yield* sql.unsafe<{
              id: string;
              verdict: unknown;
            }>(
              `SELECT a.id, json_extract(v.payload, '$.verdict') AS verdict
          FROM j5_workflow_artifacts AS a JOIN j5_workflow_values AS v ON v.hash=a.hash
          WHERE a.run_id=? AND a.id IN (${artifactIds.map(() => "?").join(",")})`,
              [runId, ...artifactIds],
            );
      const verdicts = new Map<string, string | null>(
        verdictRows.map((row) => [row.id, typeof row.verdict === "string" ? row.verdict : null]),
      );
      return yield* decodeTimeline({
        runId,
        headRevision: head.headRevision,
        readVersion: head.readVersion,
        revisions: deriveTimelineRevisions(
          [...predecessor, ...selected].sort((left, right) => left.revision - right.revision),
          actionRows,
          verdicts,
          selectedRevisions,
        ),
        nextBefore: rows.length > boundedLimit ? oldest : null,
      });
    }),
  );
});
