import type { Action, Decision, Run } from "@j5/workflow-contracts";
import { hash, gateHash, phaseById, type Definition } from "./Definition.ts";

export type Event =
  | { readonly type: "enter" }
  | { readonly type: "result"; readonly actionId: string; readonly output: unknown }
  | {
      readonly type: "block";
      readonly actionId: string;
      readonly cause: string;
      readonly recovery: Run["recovery"];
      readonly failureCategory?: NonNullable<Run["failureCategory"]>;
    }
  | { readonly type: "decision"; readonly decision: Decision }
  | { readonly type: "retry" }
  | { readonly type: "cancel" }
  | { readonly type: "cancelled" }
  | { readonly type: "invalidate"; readonly cause: string }
  | {
      readonly type: "edit_gate";
      readonly gateRevision: number;
      readonly artifactHash: string;
      readonly content: unknown;
      readonly actor: string;
    }
  | { readonly type: "recover" };

export class Conflict extends Error {}
export const actionId = (run: Run, task: string, attempt: number): string =>
  `wf:${hash([run.id, run.phase, run.revision, task, attempt])}`;

const blocked = (
  run: Run,
  cause: string,
  recovery: Run["recovery"] = null,
  failureCategory: NonNullable<Run["failureCategory"]> = "unknown",
  relevantActionId: string | null = null,
): Run => ({
  ...run,
  status: "blocked",
  cause,
  failureCategory,
  relevantActionId,
  recovery,
  gate: null,
});

function enter(run: Run, definition: Definition, next: string, now: number): Run {
  if (next === "$complete")
    return {
      ...run,
      status: "completed",
      gate: null,
      cause: null,
      failureCategory: null,
      relevantActionId: null,
      recovery: null,
    };
  const phase = phaseById(definition, next);
  const visits = (run.visits[next] ?? 0) + 1;
  if (visits > phase.maxVisits)
    return blocked(run, `Revision budget exhausted for ${next}`, null, "revision_budget_exhausted");
  const current: Run = {
    ...run,
    phase: next,
    visits: { ...run.visits, [next]: visits },
    gate: null,
    cause: null,
    failureCategory: null,
    relevantActionId: null,
    recovery: null,
    status: phase.kind === "gate" ? "waiting_approval" : "running",
  };
  if (phase.kind === "gate") {
    const artifacts = definition.gateArtifacts(current, phase);
    if (artifacts.length === 0)
      return blocked(current, "Required gate evidence is missing", null, "missing_gate_evidence");
    return {
      ...current,
      gate: {
        revision: current.revision,
        artifactHash: gateHash(artifacts),
        artifactIds: artifacts.map((artifact) => artifact.id),
      },
    };
  }
  const actions: Action[] = phase.tasks.map((task) => ({
    id: actionId(current, task.id, 1),
    runId: current.id,
    phase: next,
    revision: current.revision,
    task: task.id,
    attempt: 1,
    kind: phase.kind as "agent" | "code",
    adapter: task.adapter,
    status: "pending",
    deadline: now + 30 * 60 * 1000,
    input: definition.input(current, phase, task),
    result: null,
  }));
  return { ...current, actions: [...current.actions, ...actions] };
}

/** No clocks, persistence, model calls, or filesystem operations in the transition function. */
export function decide(
  previous: Run,
  event: Event,
  definition: Definition | undefined,
  now: number,
): Run {
  if (["completed", "cancelled", "failed"].includes(previous.status)) return previous;
  if (event.type === "cancel")
    return {
      ...previous,
      revision: previous.revision + 1,
      status: "cancelling",
      gate: null,
      actions: previous.actions.map((action) =>
        action.status === "completed" ? action : { ...action, status: "cancelled" },
      ),
    };
  if (previous.status === "cancelling") {
    return event.type === "cancelled"
      ? { ...previous, revision: previous.revision + 1, status: "cancelled" }
      : previous;
  }
  if (
    !definition ||
    definition.hash !== previous.definitionHash ||
    definition.version !== previous.definitionVersion
  ) {
    return {
      ...blocked(
        previous,
        "Pinned workflow definition is unavailable or changed",
        "restore_definition",
        "definition_mismatch",
      ),
      gate: previous.gate,
      revision: previous.revision + 1,
    };
  }
  if (event.type === "recover")
    return previous.recovery === "restore_definition"
      ? {
          ...previous,
          revision: previous.revision + 1,
          status: previous.gate ? "waiting_approval" : "running",
          cause: null,
          failureCategory: null,
          relevantActionId: null,
          recovery: null,
        }
      : previous;
  let run: Run = { ...previous, revision: previous.revision + 1 };
  const phase = phaseById(definition, run.phase);
  if (event.type === "invalidate") {
    const next = phase.transitions.changed;
    run = {
      ...run,
      actions: run.actions.map((action) =>
        action.status === "completed" ? action : { ...action, status: "cancelled" },
      ),
    };
    return next
      ? enter(run, definition, next, now)
      : blocked(run, event.cause, null, "candidate_changed");
  }
  if (event.type === "edit_gate") {
    if (
      previous.status !== "waiting_approval" ||
      !previous.gate ||
      previous.gate.revision !== event.gateRevision ||
      previous.gate.artifactHash !== event.artifactHash ||
      !definition.editGate
    ) {
      throw new Conflict("Gate cannot be edited or has changed");
    }
    const edit = definition.editGate(previous, event.content);
    const artifact = {
      ...edit.artifact,
      id: `gate:${run.id}:${run.revision}`,
      content: edit.content,
      hash: hash(edit.content),
      producer: event.actor,
      revision: run.revision,
      governs: [edit.artifact.hash],
    };
    run = { ...run, artifacts: [...run.artifacts, artifact] };
    const artifacts = definition.gateArtifacts(run, phase);
    return {
      ...run,
      gate: {
        revision: run.revision,
        artifactHash: gateHash(artifacts),
        artifactIds: artifacts.map((item) => item.id),
      },
    };
  }
  if (event.type === "enter") {
    if (Object.keys(run.visits).length !== 0) throw new Conflict("Run has already started");
    return enter(run, definition, definition.initial, now);
  }
  if (event.type === "decision") {
    const decision = event.decision;
    if (
      previous.status !== "waiting_approval" ||
      !previous.gate ||
      decision.gateRevision !== previous.gate.revision ||
      decision.artifactHash !== previous.gate.artifactHash
    ) {
      throw new Conflict("Gate or reviewed artifact has changed");
    }
    if (decision.decision === "request_changes" && !decision.feedback.trim())
      throw new Conflict("Feedback is required");
    run = { ...run, approvals: [...run.approvals, decision] };
    if (decision.decision === "cancel")
      return { ...decide(previous, { type: "cancel" }, definition, now), approvals: run.approvals };
    const next = phase.transitions[decision.decision];
    return next
      ? enter(run, definition, next, now)
      : blocked(run, "Gate has no permitted transition", null, "transition_unavailable");
  }
  if (event.type === "retry") {
    if (previous.status !== "blocked" || previous.recovery !== "retry")
      throw new Conflict("This failure cannot be retried");
    // Retain identity and deadline: retry means reconcile the interrupted action, not a fresh launch.
    return {
      ...run,
      status: "running",
      cause: null,
      failureCategory: null,
      relevantActionId: null,
      recovery: null,
      actions: run.actions.map((action) =>
        action.status === "blocked" ? { ...action, status: "pending" } : action,
      ),
    };
  }
  if (event.type === "result" || event.type === "block") {
    const action = run.actions.find((candidate) => candidate.id === event.actionId);
    if (
      !action ||
      !["pending", "claimed"].includes(action.status) ||
      action.phase !== run.phase ||
      previous.status !== "running"
    )
      return previous;
    if (event.type === "block")
      return blocked(
        {
          ...run,
          actions: run.actions.map((item) =>
            item.id === action.id ? { ...item, status: "blocked" } : item,
          ),
        },
        event.cause,
        event.recovery,
        event.failureCategory ?? "action_failed",
        action.id,
      );
    if (now >= action.deadline)
      return blocked(
        run,
        `Attempt deadline expired: ${action.id}`,
        null,
        "action_deadline_expired",
        action.id,
      );
    let content: unknown;
    try {
      content = definition.validate(action, event.output, previous);
    } catch (error) {
      if (action.kind !== "agent" || action.attempt >= 3)
        return blocked(
          run,
          `Invalid output: ${String(error)}`,
          null,
          "invalid_action_output",
          action.id,
        );
      const corrected: Action = {
        ...action,
        revision: run.revision,
        id: actionId(run, action.task, action.attempt + 1),
        attempt: action.attempt + 1,
        status: "pending",
        input: { original: action.input, correction: String(error), output: event.output },
      };
      return {
        ...run,
        actions: [
          ...run.actions.map((item) =>
            item.id === action.id ? { ...item, status: "cancelled" as const } : item,
          ),
          corrected,
        ],
      };
    }
    const artifact = {
      id: `${action.id}:artifact`,
      hash: hash(content),
      content,
      producer: action.task,
      phase: action.phase,
      revision: action.revision,
      attempt: action.attempt,
      governs: previous.artifacts.map((item) => item.hash),
    };
    run = {
      ...run,
      artifacts: [...run.artifacts, artifact],
      actions: run.actions.map((item) =>
        item.id === action.id ? { ...item, status: "completed", result: artifact } : item,
      ),
    };
    const currentActions = phase.tasks.map((task) =>
      run.actions.findLast((item) => item.phase === phase.id && item.task === task.id),
    );
    if (currentActions.some((item) => item?.status !== "completed")) return run;
    const artifacts = currentActions.flatMap((item) => (item?.result ? [item.result] : []));
    const outcome = definition.outcome(run, phase, artifacts);
    const next = phase.transitions[outcome];
    return next
      ? enter(run, definition, next, now)
      : blocked(run, `Phase ${phase.id} stopped: ${outcome}`, null, "transition_unavailable");
  }
  return previous;
}
