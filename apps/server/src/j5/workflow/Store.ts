import {
  Artifact,
  ArtifactMetadata,
  Run,
  RunDetail,
  type Action,
  type ActionSummary,
  type Decision,
} from "@j5/workflow-contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { decide, Conflict, type Event } from "./decider.ts";
import { canonical, hash, type Definition } from "./Definition.ts";

export class WorkflowError extends Schema.TaggedErrorClass<WorkflowError>()("WorkflowError", {
  code: Schema.Literals(["conflict", "not_found", "storage", "invalid"]),
  detail: Schema.String,
}) {}

const decodeRun = Schema.decodeUnknownEffect(Run);
const decodeDetail = Schema.decodeUnknownEffect(RunDetail);
const decodeArtifact = Schema.decodeUnknownEffect(Artifact);
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeStringArrayJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

export interface Claim {
  readonly actionId: string;
  readonly owner: string;
  readonly generation: number;
}

interface StoredAction extends Omit<Action, "input"> {
  readonly inputHash: string;
}

type StoredArtifact = typeof ArtifactMetadata.Type;

interface RunSnapshot {
  readonly id: string;
  readonly definitionId: string;
  readonly definitionVersion: number;
  readonly definitionHash: string;
  readonly squadronId: string;
  readonly projectId: string;
  readonly repository: string;
  readonly baseCommit: string;
  readonly inputsHash: string;
  readonly executionHash: string;
  readonly phase: string;
  readonly revision: number;
  readonly status: Run["status"];
  readonly cause: string | null;
  readonly failureCategory?: Run["failureCategory"];
  readonly relevantActionId?: Run["relevantActionId"];
  readonly recovery: Run["recovery"];
  readonly restart?: Run["restart"];
  readonly definitionUpgrades?: Run["definitionUpgrades"];
  readonly gate: Run["gate"];
  readonly actions: ReadonlyArray<StoredAction>;
  readonly artifacts: ReadonlyArray<StoredArtifact>;
  readonly approvals: ReadonlyArray<Decision>;
  readonly visits: Readonly<Record<string, number>>;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly readVersion?: number;
}

export interface SchedulingRecord {
  readonly id: string;
  readonly definitionId: string;
  readonly definitionVersion: number;
  readonly definitionHash: string;
  readonly phase: string;
  readonly revision: number;
  readonly status: Run["status"];
  readonly creationSequence: number;
}

const parseSnapshot = (payload: string): RunSnapshot => JSON.parse(payload) as RunSnapshot;
const statusPriority = (status: Run["status"]): number => {
  switch (status) {
    case "waiting_approval":
      return 0;
    case "blocked":
      return 1;
    case "failed":
      return 2;
    case "running":
      return 3;
    case "restarting":
      return 3;
    case "cancelling":
      return 4;
    default:
      return 5;
  }
};
const requestTitle = (inputs: unknown): string => {
  if (inputs !== null && typeof inputs === "object" && "request" in inputs) {
    const request = inputs.request;
    if (typeof request === "string" && request.length > 0) return request;
  }
  return "Development workflow";
};
const storedAction = (action: Action): StoredAction => {
  const { input, ...metadata } = action;
  return { ...metadata, inputHash: hash(input) };
};
const storedArtifact = (artifact: Artifact): StoredArtifact => {
  const { content: _content, ...metadata } = artifact;
  return metadata;
};
const snapshotOf = (run: Run): RunSnapshot => ({
  id: run.id,
  definitionId: run.definitionId,
  definitionVersion: run.definitionVersion,
  definitionHash: run.definitionHash,
  squadronId: run.squadronId,
  projectId: run.projectId,
  repository: run.repository,
  baseCommit: run.baseCommit,
  inputsHash: hash(run.inputs),
  executionHash: hash(run.execution),
  phase: run.phase,
  revision: run.revision,
  status: run.status,
  cause: run.cause,
  ...(run.failureCategory === undefined ? {} : { failureCategory: run.failureCategory }),
  ...(run.relevantActionId === undefined ? {} : { relevantActionId: run.relevantActionId }),
  recovery: run.recovery,
  ...(run.restart === undefined ? {} : { restart: run.restart }),
  ...(run.definitionUpgrades === undefined ? {} : { definitionUpgrades: run.definitionUpgrades }),
  gate: run.gate,
  actions: run.actions.map(storedAction),
  artifacts: run.artifacts.map(storedArtifact),
  approvals: run.approvals,
  visits: run.visits,
  ...(run.createdAt === undefined ? {} : { createdAt: run.createdAt }),
  ...(run.updatedAt === undefined ? {} : { updatedAt: run.updatedAt }),
  ...(run.readVersion === undefined ? {} : { readVersion: run.readVersion }),
});

export const makeStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const valuesFor = Effect.fn("WorkflowStore.valuesFor")(function* (hashes: ReadonlyArray<string>) {
    if (hashes.length === 0) return new Map<string, unknown>();
    const rows = yield* sql<{ hash: string; payload: string }>`SELECT hash, payload
      FROM j5_workflow_values WHERE hash IN ${sql.in([...new Set(hashes)])}`;
    return new Map(rows.map((row) => [row.hash, JSON.parse(row.payload) as unknown]));
  });

  const hydrate = Effect.fn("WorkflowStore.hydrate")(function* (
    snapshot: RunSnapshot,
    currentIdentities: boolean,
  ) {
    const values = yield* valuesFor([
      snapshot.inputsHash,
      snapshot.executionHash,
      ...snapshot.actions.map((action) => action.inputHash),
      ...snapshot.artifacts.map((artifact) => artifact.hash),
    ]);
    const identities = currentIdentities
      ? yield* sql<{ id: string; identity: string | null }>`SELECT id, identity
          FROM j5_workflow_actions WHERE run_id=${snapshot.id}`
      : [];
    const identityByAction = new Map(identities.map((row) => [row.id, row.identity]));
    const artifacts = snapshot.artifacts.map((metadata) => ({
      ...metadata,
      content: values.get(metadata.hash),
    }));
    const run = {
      ...snapshot,
      inputs: values.get(snapshot.inputsHash),
      execution: values.get(snapshot.executionHash),
      actions: snapshot.actions.map(({ inputHash, ...metadata }) => {
        const identity = identityByAction.get(metadata.id);
        return {
          ...metadata,
          input: values.get(inputHash),
          ...(identity ? { externalIdentity: identity } : {}),
        };
      }),
      artifacts,
    };
    const { inputsHash: _inputsHash, executionHash: _executionHash, ...hydrated } = run;
    return yield* decodeRun(hydrated);
  });

  const get = Effect.fn("WorkflowStore.get")(function* (id: string) {
    const rows = yield* sql<{ payload: string; readVersion: number }>`SELECT payload,
      read_version AS readVersion FROM j5_workflow_runs WHERE id=${id}`;
    if (!rows[0])
      return yield* new WorkflowError({ code: "not_found", detail: `Unknown workflow ${id}` });
    const run = yield* hydrate(parseSnapshot(rows[0].payload), true);
    return { ...run, readVersion: rows[0].readVersion };
  });

  const detail = Effect.fn("WorkflowStore.detail")(function* (id: string) {
    const rows = yield* sql<{ payload: string; title: string; readVersion: number }>`SELECT
      payload, title, read_version AS readVersion FROM j5_workflow_runs WHERE id=${id}`;
    const row = rows[0];
    if (!row)
      return yield* new WorkflowError({ code: "not_found", detail: `Unknown workflow ${id}` });
    const snapshot = parseSnapshot(row.payload);
    const identities = yield* sql<{ id: string; identity: string | null }>`SELECT id, identity
      FROM j5_workflow_actions WHERE run_id=${id}`;
    const identityByAction = new Map(identities.map((item) => [item.id, item.identity]));
    const actions: ActionSummary[] = snapshot.actions.map(
      ({ inputHash: _inputHash, ...action }) => {
        const identity = identityByAction.get(action.id);
        return { ...action, ...(identity ? { externalIdentity: identity } : {}) };
      },
    );
    return yield* decodeDetail({
      id: snapshot.id,
      definitionId: snapshot.definitionId,
      definitionVersion: snapshot.definitionVersion,
      definitionHash: snapshot.definitionHash,
      squadronId: snapshot.squadronId,
      projectId: snapshot.projectId,
      repository: snapshot.repository,
      baseCommit: snapshot.baseCommit,
      request: row.title,
      phase: snapshot.phase,
      revision: snapshot.revision,
      readVersion: row.readVersion,
      status: snapshot.status,
      cause: snapshot.cause,
      ...(snapshot.failureCategory === undefined
        ? {}
        : { failureCategory: snapshot.failureCategory }),
      ...(snapshot.relevantActionId === undefined
        ? {}
        : { relevantActionId: snapshot.relevantActionId }),
      recovery: snapshot.recovery,
      ...(snapshot.restart === undefined ? {} : { restart: snapshot.restart }),
      ...(snapshot.definitionUpgrades === undefined
        ? {}
        : { definitionUpgrades: snapshot.definitionUpgrades }),
      restartAvailability: {
        available: false,
        reason: "Restart availability has not been evaluated",
        targetDefinitionHash: snapshot.definitionHash,
        nextVisit: null,
        maxVisits: null,
        compatibleDefinitionUpgrade: false,
      },
      gate: snapshot.gate,
      actions,
      artifacts: snapshot.artifacts,
      approvals: snapshot.approvals,
      visits: snapshot.visits,
      ...(snapshot.createdAt === undefined ? {} : { createdAt: snapshot.createdAt }),
      ...(snapshot.updatedAt === undefined ? {} : { updatedAt: snapshot.updatedAt }),
    });
  });

  const readVersion = Effect.fn("WorkflowStore.readVersion")(function* (id: string) {
    const rows = yield* sql<{ readVersion: number }>`SELECT read_version AS readVersion
      FROM j5_workflow_runs WHERE id=${id}`;
    if (!rows[0])
      return yield* new WorkflowError({ code: "not_found", detail: `Unknown workflow ${id}` });
    return rows[0].readVersion;
  });

  const artifact = Effect.fn("WorkflowStore.artifact")(function* (
    runId: string,
    artifactId: string,
  ) {
    const rows = yield* sql<{
      id: string;
      hash: string;
      producer: string;
      phase: string;
      revision: number;
      attempt: number;
      governs: string;
      content: string;
    }>`SELECT a.id, a.hash, a.producer, a.phase, a.revision, a.attempt,
        a.governs_json AS governs, v.payload AS content
      FROM j5_workflow_artifacts a
      JOIN j5_workflow_values v ON v.hash=a.hash
      WHERE a.run_id=${runId} AND a.id=${artifactId}`;
    const row = rows[0];
    if (!row)
      return yield* new WorkflowError({ code: "not_found", detail: "Unknown workflow artifact" });
    return yield* decodeArtifact({
      ...row,
      governs: decodeStringArrayJson(row.governs),
      content: decodeUnknownJson(row.content),
    });
  });

  const putValue = (value: unknown) => {
    const valueHash = hash(value);
    return sql`INSERT OR IGNORE INTO j5_workflow_values(hash, payload)
      VALUES (${valueHash}, ${canonical(value)})`;
  };

  const present = Effect.fn("WorkflowStore.present")(function* (run: Run) {
    return yield* decodeDetail({
      id: run.id,
      definitionId: run.definitionId,
      definitionVersion: run.definitionVersion,
      definitionHash: run.definitionHash,
      squadronId: run.squadronId,
      projectId: run.projectId,
      repository: run.repository,
      baseCommit: run.baseCommit,
      request: requestTitle(run.inputs),
      phase: run.phase,
      revision: run.revision,
      readVersion: run.readVersion ?? 0,
      status: run.status,
      cause: run.cause,
      ...(run.failureCategory === undefined ? {} : { failureCategory: run.failureCategory }),
      ...(run.relevantActionId === undefined ? {} : { relevantActionId: run.relevantActionId }),
      recovery: run.recovery,
      ...(run.restart === undefined ? {} : { restart: run.restart }),
      ...(run.definitionUpgrades === undefined
        ? {}
        : { definitionUpgrades: run.definitionUpgrades }),
      restartAvailability: {
        available: false,
        reason: "Restart availability has not been evaluated",
        targetDefinitionHash: run.definitionHash,
        nextVisit: null,
        maxVisits: null,
        compatibleDefinitionUpgrade: false,
      },
      gate: run.gate,
      actions: run.actions.map(({ input: _input, ...action }) => action),
      artifacts: run.artifacts.map(storedArtifact),
      approvals: run.approvals,
      visits: run.visits,
      ...(run.createdAt === undefined ? {} : { createdAt: run.createdAt }),
      ...(run.updatedAt === undefined ? {} : { updatedAt: run.updatedAt }),
    });
  });

  const save = Effect.fn("WorkflowStore.save")(function* (
    run: Run,
    commandId: string,
    event: Event,
    now: number,
  ) {
    for (const value of [
      run.inputs,
      run.execution,
      ...run.actions.map((action) => action.input),
      ...run.artifacts.map((item) => item.content),
    ]) {
      yield* putValue(value);
    }
    for (const action of run.actions) {
      const inputHash = hash(action.input);
      yield* sql`INSERT INTO j5_workflow_actions(
          id, run_id, phase, revision, task, attempt, kind, adapter, status,
          deadline, input_hash, result_artifact_id, identity
        ) VALUES (
          ${action.id}, ${run.id}, ${action.phase}, ${action.revision}, ${action.task},
          ${action.attempt}, ${action.kind}, ${action.adapter}, ${action.status},
          ${action.deadline}, ${inputHash}, ${action.resultArtifactId},
          ${action.externalIdentity ?? null}
        ) ON CONFLICT(id) DO UPDATE SET
          status=excluded.status,
          result_artifact_id=excluded.result_artifact_id,
          identity=coalesce(j5_workflow_actions.identity, excluded.identity)
        WHERE j5_workflow_actions.status IS NOT excluded.status
          OR j5_workflow_actions.result_artifact_id IS NOT excluded.result_artifact_id
          OR (j5_workflow_actions.identity IS NULL AND excluded.identity IS NOT NULL)`;
    }
    for (const item of run.artifacts) {
      yield* sql`INSERT OR IGNORE INTO j5_workflow_artifacts(
          id, run_id, hash, producer, phase, revision, attempt, governs_json
        ) VALUES (
          ${item.id}, ${run.id}, ${item.hash}, ${item.producer}, ${item.phase},
          ${item.revision}, ${item.attempt}, ${canonical(item.governs)}
        )`;
    }
    const priorVersions = yield* sql<{ readVersion: number }>`SELECT read_version AS readVersion
      FROM j5_workflow_runs WHERE id=${run.id}`;
    const readVersion = (priorVersions[0]?.readVersion ?? 0) + 1;
    const responseRun = { ...run, readVersion };
    const snapshot = snapshotOf(responseRun);
    const payload = canonical(snapshot);
    yield* sql`INSERT INTO j5_workflow_runs(
        id, definition_id, definition_version, definition_hash, squadron_id,
        project_id, title, phase, gate_revision, activity_at, status_priority,
        revision, read_version, status, payload
      ) VALUES (
        ${run.id}, ${run.definitionId}, ${run.definitionVersion}, ${run.definitionHash},
        ${run.squadronId}, ${run.projectId}, ${requestTitle(run.inputs)}, ${run.phase},
        ${run.gate?.revision ?? null}, ${now}, ${statusPriority(run.status)}, ${run.revision},
        ${readVersion}, ${run.status}, ${payload}
      ) ON CONFLICT(id) DO UPDATE SET
        definition_version=excluded.definition_version,
        definition_hash=excluded.definition_hash,
        phase=excluded.phase, gate_revision=excluded.gate_revision,
        activity_at=excluded.activity_at, status_priority=excluded.status_priority,
        revision=excluded.revision, read_version=j5_workflow_runs.read_version+1,
        status=excluded.status, payload=excluded.payload`;
    yield* sql`INSERT INTO j5_workflow_history(run_id, revision, command_id, payload)
      VALUES (${run.id}, ${run.revision}, ${commandId}, ${canonical(event)})`;
    return { payload, run: responseRun };
  });

  const command = Effect.fn("WorkflowStore.command")(function* (
    input: {
      readonly commandId: string;
      readonly runId: string;
      readonly expectedRevision: number;
      readonly event: Event;
      readonly now: number;
      readonly initial?: Run;
      readonly claim?: Claim;
      readonly receiptInput?: unknown;
    },
    definition: Definition | undefined,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const inputHash = hash(
          input.receiptInput ?? {
            runId: input.runId,
            expectedRevision: input.expectedRevision,
            event: input.event,
            initial: input.initial ?? null,
          },
        );
        const receipts = yield* sql<{ input_hash: string; payload: string }>`SELECT
          input_hash, payload FROM j5_workflow_receipts WHERE command_id=${input.commandId}`;
        if (receipts[0]) {
          if (receipts[0].input_hash !== inputHash)
            return yield* new WorkflowError({
              code: "conflict",
              detail: "Command id was reused with different input",
            });
          return yield* hydrate(parseSnapshot(receipts[0].payload), false);
        }
        if (input.claim) {
          const owned = yield* sql`SELECT id FROM j5_workflow_actions
            WHERE id=${input.claim.actionId} AND owner=${input.claim.owner}
              AND generation=${input.claim.generation} AND lease_until>${input.now}`;
          if (!owned.length)
            return yield* new WorkflowError({
              code: "conflict",
              detail: "Worker claim was superseded",
            });
        }
        let previous: Run;
        if (input.initial) {
          const exists = yield* sql`SELECT id FROM j5_workflow_runs WHERE id=${input.runId}`;
          if (exists.length)
            return yield* new WorkflowError({ code: "conflict", detail: "Run already exists" });
          previous = input.initial;
        } else {
          previous = yield* get(input.runId);
        }
        if (previous.revision !== input.expectedRevision)
          return yield* new WorkflowError({ code: "conflict", detail: "Run revision changed" });
        const next = yield* Effect.try({
          try: () => decide(previous, input.event, definition, input.now),
          catch: (error) =>
            new WorkflowError({
              code: error instanceof Conflict ? "conflict" : "invalid",
              detail: String(error),
            }),
        });
        const persisted =
          next === previous
            ? previous
            : { ...next, updatedAt: DateTime.formatIso(DateTime.makeUnsafe(input.now)) };
        const saved =
          next === previous
            ? { payload: canonical(snapshotOf(previous)), run: previous }
            : yield* save(persisted, input.commandId, input.event, input.now);
        yield* sql`INSERT INTO j5_workflow_receipts(command_id, input_hash, run_id, payload)
          VALUES (${input.commandId}, ${inputHash}, ${next.id}, ${saved.payload})`;
        return saved.run;
      }),
    );
  });

  const receipt = Effect.fn("WorkflowStore.receipt")(function* (
    commandId: string,
    receiptInput: unknown,
  ) {
    const rows = yield* sql<{ input_hash: string; payload: string }>`SELECT input_hash, payload
      FROM j5_workflow_receipts WHERE command_id=${commandId}`;
    if (!rows[0]) return null;
    if (rows[0].input_hash !== hash(receiptInput))
      return yield* new WorkflowError({
        code: "conflict",
        detail: "Command id was reused with different input",
      });
    return yield* hydrate(parseSnapshot(rows[0].payload), false);
  });

  const claim = Effect.fn("WorkflowStore.claim")(function* (
    actionId: string,
    owner: string,
    now: number,
  ) {
    const rows = yield* sql<{ generation: number }>`UPDATE j5_workflow_actions
      SET owner=${owner}, lease_until=${now + 60_000}, generation=generation+1
      WHERE id=${actionId} AND status IN ('pending','claimed')
        AND (owner IS NULL OR lease_until<=${now})
        AND EXISTS (SELECT 1 FROM j5_workflow_runs r WHERE r.id=run_id AND r.status='running')
      RETURNING generation`;
    return rows[0] ? ({ actionId, owner, generation: rows[0].generation } satisfies Claim) : null;
  });

  const identity = Effect.fn("WorkflowStore.identity")(function* (
    claim: Claim,
    value: string,
    now: number,
  ) {
    const current = yield* sql<{ runId: string; identity: string | null }>`SELECT
      run_id AS runId, identity FROM j5_workflow_actions
      WHERE id=${claim.actionId} AND owner=${claim.owner} AND generation=${claim.generation}
        AND lease_until>${now}`;
    if (!current[0] || (current[0].identity !== null && current[0].identity !== value))
      return yield* new WorkflowError({
        code: "conflict",
        detail: "Action identity or claim changed",
      });
    if (current[0].identity === value) return;
    const rows = yield* sql<{ runId: string }>`UPDATE j5_workflow_actions SET identity=${value}
      WHERE id=${claim.actionId} AND owner=${claim.owner} AND generation=${claim.generation}
        AND lease_until>${now} AND identity IS NULL
      RETURNING run_id AS runId`;
    if (!rows[0])
      return yield* new WorkflowError({
        code: "conflict",
        detail: "Action identity or claim changed",
      });
    yield* sql`UPDATE j5_workflow_runs SET read_version=read_version+1, activity_at=${now}
      WHERE id=${rows[0].runId}`;
  });

  const renew = (claim: Claim, now: number) => sql`UPDATE j5_workflow_actions
    SET lease_until=${now + 60_000}
    WHERE id=${claim.actionId} AND owner=${claim.owner} AND generation=${claim.generation}
      AND lease_until>${now} RETURNING id`;
  const release = (claim: Claim) => sql`UPDATE j5_workflow_actions SET owner=NULL, lease_until=NULL
    WHERE id=${claim.actionId} AND owner=${claim.owner} AND generation=${claim.generation}`;

  const activeMaxSequence = Effect.fn("WorkflowStore.activeMaxSequence")(function* () {
    const rows = yield* sql<{ maximum: number | null }>`SELECT max(creation_sequence) AS maximum
      FROM j5_workflow_runs WHERE status IN ('running','restarting','cancelling')`;
    return rows[0]?.maximum ?? 0;
  });
  const activeBatch = Effect.fn("WorkflowStore.activeBatch")(function* (
    afterSequence: number,
    throughSequence: number,
    limit = 100,
  ) {
    return yield* sql<SchedulingRecord>`SELECT id, definition_id AS definitionId,
      definition_version AS definitionVersion, definition_hash AS definitionHash,
      phase, revision, status, creation_sequence AS creationSequence
      FROM j5_workflow_runs
      WHERE status IN ('running','restarting','cancelling')
        AND creation_sequence>${afterSequence} AND creation_sequence<=${throughSequence}
      ORDER BY creation_sequence LIMIT ${Math.min(100, Math.max(1, limit))}`;
  });
  const watchedBatch = Effect.fn("WorkflowStore.watchedBatch")(function* (
    afterSequence: number,
    limit = 100,
  ) {
    return yield* sql<SchedulingRecord>`SELECT id, definition_id AS definitionId,
      definition_version AS definitionVersion, definition_hash AS definitionHash,
      phase, revision, status, creation_sequence AS creationSequence
      FROM j5_workflow_runs
      WHERE status IN ('running','waiting_approval')
        AND phase IN ('code_review','publication_approval')
        AND creation_sequence>${afterSequence}
      ORDER BY creation_sequence LIMIT ${Math.min(100, Math.max(1, limit))}`;
  });

  return {
    get,
    detail,
    readVersion,
    present,
    artifact,
    receipt,
    command,
    claim,
    identity,
    renew,
    release,
    activeMaxSequence,
    activeBatch,
    watchedBatch,
  };
});

export type Store = Effect.Success<typeof makeStore>;
