import type {
  AgentPersonaReviewIndependence,
  OrchestrationV2AgentPersonaAssignment,
  OrchestrationV2AppThread,
  OrchestrationV2Run,
  ThreadId,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { getThreadRecordsIfPresent } from "../a2a/threadProjectionReads.ts";

/** The work an independent reviewer reviews: the models it ran on, and where it ran. */
export interface ReviewAuthors {
  readonly models: ReadonlyArray<string>;
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly partlyUnknown: boolean;
}

/** One thread whose work a reviewer reviews. */
export interface ReviewAuthorThread {
  readonly threadId: ThreadId;
  /** Someone named it, so a missing thread is bad input; a default author that is gone is skipped. */
  readonly named?: boolean | undefined;
  /** A default author (a Crew member, a delegate_task child) that was itself a reviewer wrote none of the work. */
  readonly skipReviewer?: boolean | undefined;
}

/** Whose work a reviewer reviews: author threads, and models known without one (a seat on the same roster). */
export interface ReviewAuthorsRequest {
  readonly threads: ReadonlyArray<ReviewAuthorThread>;
  readonly models?: ReadonlyArray<string> | undefined;
  /** Some authors are known to exist but not their models. */
  readonly partlyUnknown?: boolean | undefined;
}

class ReviewAuthorThreadMissingError extends Data.TaggedError("ReviewAuthorThreadMissingError")<{
  readonly threadId: ThreadId;
}> {
  override get message() {
    return `Author thread ${this.threadId} does not exist.`;
  }
}

const threadModels = (
  thread: Pick<OrchestrationV2AppThread, "modelSelection" | "agentPersonaAssignment">,
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "modelSelection">>,
) => [
  thread.modelSelection.model,
  ...runs.map(({ modelSelection }) => modelSelection.model),
  ...(thread.agentPersonaAssignment == null
    ? []
    : [thread.agentPersonaAssignment.resolvedModelSelection.model]),
];

/**
 * An author thread is its own work and its delegate_task children's, at any depth. A
 * provider-native child's model is not known, so it makes the authors partly unknown.
 */
export const resolveReviewAuthors = Effect.fn("j5.agents.resolveReviewAuthors")(function* (
  request: ReviewAuthorsRequest,
) {
  const threads = yield* ThreadManagementService;
  const models = new Set(request.models ?? []);
  const threadIds: Array<ThreadId> = [];
  let partlyUnknown = request.partlyUnknown === true;
  const queue = [...request.threads];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (threadIds.includes(next.threadId)) continue;
    const records = yield* getThreadRecordsIfPresent(threads, next.threadId, ["runs", "subagents"]);
    if (records === null || records.thread.deletedAt !== null) {
      if (next.named === true)
        return yield* new ReviewAuthorThreadMissingError({ threadId: next.threadId });
      continue;
    }
    if (
      next.skipReviewer === true &&
      records.thread.agentPersonaAssignment?.reviewIndependence !== undefined
    )
      continue;
    threadIds.push(next.threadId);
    for (const model of threadModels(records.thread, records.runs)) models.add(model);
    for (const child of records.subagents) {
      if (child.origin === "provider_native") partlyUnknown = true;
      // A delegate_task child that was itself an independent reviewer wrote none of the work.
      else if (child.childThreadId !== null)
        queue.push({ threadId: child.childThreadId, skipReviewer: true });
    }
  }
  return { models: [...models], threadIds, partlyUnknown } satisfies ReviewAuthors;
});

export const reviewIndependenceOf = (
  authors: ReviewAuthors,
  model: string,
  modelChosenBy: AgentPersonaReviewIndependence["modelChosenBy"],
): AgentPersonaReviewIndependence => ({
  outcome: authors.models.includes(model)
    ? "same-model-as-author"
    : authors.models.length === 0 || authors.partlyUnknown
      ? "unknown-authors"
      : "different-model",
  authorModels: authors.models,
  authorThreadIds: authors.threadIds,
  partlyUnknown: authors.partlyUnknown,
  modelChosenBy,
});

/** The line an independent reviewer's first turn carries, so it knows how independent its review is. */
const reviewIndependenceNote = (
  { outcome, authorModels, partlyUnknown, modelChosenBy }: AgentPersonaReviewIndependence,
  model: string,
) => {
  const head =
    outcome === "same-model-as-author"
      ? `Review independence: you run on the same model as the author (${model}), because ${modelChosenBy === "server" ? "no other model in your list could run" : "it was chosen explicitly"}.`
      : authorModels.length === 0
        ? `Review independence: you run on ${model}; the authors of this work are unknown.`
        : `Review independence: you run on ${model}; the ${partlyUnknown ? "known " : ""}authors ran on ${authorModels.join(", ")}.`;
  if (partlyUnknown)
    return `${head} Some authors are unknown (work done by native subagents), so this is not a verified independent review.`;
  return outcome === "unknown-authors"
    ? `${head} This is not a verified independent review.`
    : head;
};

/** A first turn with the independence line appended, for a reviewer persona's assignment. */
export const withReviewIndependenceNote = (
  text: string,
  assignment:
    | Pick<OrchestrationV2AgentPersonaAssignment, "reviewIndependence" | "resolvedModelSelection">
    | null
    | undefined,
) =>
  assignment?.reviewIndependence === undefined
    ? text
    : `${text}\n\n${reviewIndependenceNote(assignment.reviewIndependence, assignment.resolvedModelSelection.model)}`;
