import { Run, RunSummary } from "@j5/workflow-contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as DateTime from "effect/DateTime";
import { decide, Conflict, type Event } from "./decider.ts";
import { canonical, hash, type Definition } from "./Definition.ts";

export class WorkflowError extends Schema.TaggedErrorClass<WorkflowError>()("WorkflowError", {
  code: Schema.Literals(["conflict", "not_found", "storage", "invalid"]),
  detail: Schema.String,
}) {}

const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(Run));
const decodeSummary = Schema.decodeUnknownEffect(Schema.fromJsonString(RunSummary));
const encodeRun = Schema.encodeEffect(Schema.fromJsonString(Run));
export interface Claim {
  readonly actionId: string;
  readonly owner: string;
  readonly generation: number;
}

export const makeStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const get = Effect.fn("WorkflowStore.get")(function* (id: string) {
    const rows = yield* sql<{
      payload: string;
    }>`SELECT payload FROM j5_workflow_runs WHERE id = ${id}`;
    if (!rows[0])
      return yield* new WorkflowError({ code: "not_found", detail: `Unknown workflow ${id}` });
    const run = yield* decodeRun(rows[0].payload);
    const identities = yield* sql<{
      id: string;
      identity: string;
    }>`SELECT id, identity FROM j5_workflow_actions
      WHERE run_id=${id} AND identity IS NOT NULL`;
    return {
      ...run,
      actions: run.actions.map((action) => {
        const identity = identities.find((item) => item.id === action.id)?.identity;
        return identity ? { ...action, externalIdentity: identity } : action;
      }),
    };
  });
  const list = Effect.fn("WorkflowStore.list")(function* (squadronId: string, limit = 50) {
    const rows = yield* sql<{
      payload: string;
    }>`SELECT json_remove(payload, '$.actions', '$.artifacts', '$.approvals', '$.visits', '$.inputs', '$.execution') AS payload FROM j5_workflow_runs
      WHERE squadron_id = ${squadronId} ORDER BY rowid DESC LIMIT ${Math.min(100, Math.max(1, limit))}`;
    return yield* Effect.forEach(rows, (row) => decodeSummary(row.payload));
  });
  const save = Effect.fn("WorkflowStore.save")(function* (
    run: Run,
    commandId: string,
    event: Event,
  ) {
    const payload = yield* encodeRun(run);
    yield* sql`INSERT INTO j5_workflow_runs(id, squadron_id, revision, status, payload)
      VALUES (${run.id}, ${run.squadronId}, ${run.revision}, ${run.status}, ${payload})
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, status=excluded.status, payload=excluded.payload`;
    yield* sql`INSERT INTO j5_workflow_history(run_id, revision, command_id, payload)
      VALUES (${run.id}, ${run.revision}, ${commandId}, ${canonical(event)})`;
    for (const action of run.actions) {
      yield* sql`INSERT INTO j5_workflow_actions(id, run_id, status, payload)
        VALUES (${action.id}, ${run.id}, ${action.status}, ${canonical(action)})
        ON CONFLICT(id) DO UPDATE SET status=excluded.status, payload=excluded.payload`;
      yield* sql`INSERT OR IGNORE INTO j5_workflow_attempts(action_id, run_id, phase, revision, attempt, deadline)
        VALUES (${action.id}, ${run.id}, ${action.phase}, ${action.revision}, ${action.attempt}, ${action.deadline})`;
    }
    for (const artifact of run.artifacts) {
      yield* sql`INSERT OR IGNORE INTO j5_workflow_artifacts(id, run_id, hash, payload)
        VALUES (${artifact.id}, ${run.id}, ${artifact.hash}, ${canonical(artifact)})`;
    }
    for (const [ordinal, approval] of run.approvals.entries()) {
      yield* sql`INSERT OR IGNORE INTO j5_workflow_approvals(run_id, ordinal, payload)
        VALUES (${run.id}, ${ordinal}, ${canonical(approval)})`;
    }
    return payload;
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
    },
    definition: Definition | undefined,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const inputHash = hash({
          runId: input.runId,
          expectedRevision: input.expectedRevision,
          event: input.event,
          initial: input.initial ?? null,
        });
        const receipt = yield* sql<{
          input_hash: string;
          payload: string;
        }>`SELECT input_hash, payload
        FROM j5_workflow_receipts WHERE command_id = ${input.commandId}`;
        if (receipt[0]) {
          if (receipt[0].input_hash !== inputHash)
            return yield* new WorkflowError({
              code: "conflict",
              detail: "Command id was reused with different input",
            });
          return yield* decodeRun(receipt[0].payload);
        }
        if (input.claim) {
          const owned =
            yield* sql`SELECT id FROM j5_workflow_actions WHERE id=${input.claim.actionId}
          AND owner=${input.claim.owner} AND generation=${input.claim.generation} AND lease_until > ${input.now}`;
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
        } else previous = yield* get(input.runId);
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
        const payload =
          next === previous
            ? yield* encodeRun(previous)
            : yield* save(persisted, input.commandId, input.event);
        yield* sql`INSERT INTO j5_workflow_receipts(command_id, input_hash, run_id, payload)
        VALUES (${input.commandId}, ${inputHash}, ${next.id}, ${payload})`;
        return persisted;
      }),
    );
  });
  const claim = Effect.fn("WorkflowStore.claim")(function* (
    actionId: string,
    owner: string,
    now: number,
  ) {
    const rows = yield* sql<{ generation: number }>`UPDATE j5_workflow_actions
      SET owner=${owner}, lease_until=${now + 60_000}, generation=generation+1
      WHERE id=${actionId} AND status IN ('pending','claimed')
      AND (owner IS NULL OR lease_until <= ${now})
      AND EXISTS (SELECT 1 FROM j5_workflow_runs r WHERE r.id=run_id AND r.status='running')
      RETURNING generation`;
    return rows[0] ? ({ actionId, owner, generation: rows[0].generation } satisfies Claim) : null;
  });
  const identity = Effect.fn("WorkflowStore.identity")(function* (
    claim: Claim,
    value: string,
    now: number,
  ) {
    const rows = yield* sql`UPDATE j5_workflow_actions SET identity=${value}
      WHERE id=${claim.actionId} AND owner=${claim.owner} AND generation=${claim.generation}
      AND lease_until > ${now} AND (identity IS NULL OR identity=${value}) RETURNING id`;
    if (!rows.length)
      return yield* new WorkflowError({
        code: "conflict",
        detail: "Action identity or claim changed",
      });
  });
  const renew = (
    claim: Claim,
    now: number,
  ) => sql`UPDATE j5_workflow_actions SET lease_until=${now + 60_000}
    WHERE id=${claim.actionId} AND owner=${claim.owner} AND generation=${claim.generation} AND lease_until > ${now} RETURNING id`;
  const release = (claim: Claim) => sql`UPDATE j5_workflow_actions SET owner=NULL, lease_until=NULL
    WHERE id=${claim.actionId} AND owner=${claim.owner} AND generation=${claim.generation}`;
  const active = Effect.fn("WorkflowStore.active")(function* () {
    const rows = yield* sql<{ payload: string }>`SELECT payload FROM j5_workflow_runs
      WHERE status IN ('running','cancelling') ORDER BY rowid LIMIT 100`;
    return yield* Effect.forEach(rows, (row) => decodeRun(row.payload));
  });
  const watched = Effect.fn("WorkflowStore.watched")(function* () {
    const rows = yield* sql<{ payload: string }>`SELECT payload FROM j5_workflow_runs
      WHERE status IN ('running','waiting_approval') ORDER BY rowid LIMIT 100`;
    return yield* Effect.forEach(rows, (row) => decodeRun(row.payload));
  });
  return { get, list, command, claim, identity, renew, release, active, watched };
});
export type Store = Effect.Success<typeof makeStore>;
