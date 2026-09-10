import { useAtomValue } from "@effect/atom-react";
import type { Artifact, ArtifactMetadata, RunDetail } from "@j5/workflow-contracts";
import { WorkflowEntries } from "@j5/workflow-contracts/sidebar";
import type { BoardCard } from "@j5/workflow-contracts/observability";
import { BoardPage, TimelinePage } from "@j5/workflow-contracts/observability";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { formatEnvironmentQueryError } from "../../state/query";
import {
  listWorkflowDefinitions,
  listWorkflowBoard,
  listWorkflowEntries,
  readArtifact,
  readRun,
  readWorkflowApprovalCount,
  readWorkflowTimeline,
} from "./client";

export interface WorkflowListInput {
  readonly squadronId: string;
  readonly search: string;
  readonly status: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface WorkflowQueryTarget<Input> {
  readonly environmentId: EnvironmentId;
  readonly input: Input;
}

const keyOf = <Input>(target: WorkflowQueryTarget<Input>) => JSON.stringify(target);
const listCache = new Map<string, typeof WorkflowEntries.Type>();
const boardCache = new Map<string, BoardPage>();
const timelineCache = new Map<string, TimelinePage>();
const detailCache = new Map<string, RunDetail>();
const artifactCache = new Map<string, Artifact>();
const emptyWorkflowQuery = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("j5-workflow:empty"),
);
type WorkflowAtom = Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>;
const pollable = new WeakSet<WorkflowAtom>();
const markPollable = <A extends WorkflowAtom>(atom: A): A => {
  pollable.add(atom);
  return atom;
};

export const retainWorkflowListReference = (key: string, next: typeof WorkflowEntries.Type) => {
  const previous = listCache.get(key);
  if (
    previous !== undefined &&
    previous.total === next.total &&
    previous.waitingApprovalCount === next.waitingApprovalCount &&
    previous.hasMore === next.hasMore &&
    previous.runs.length === next.runs.length &&
    previous.runs.every((run, index) => {
      const other = next.runs[index];
      return (
        other !== undefined &&
        run.id === other.id &&
        run.squadronId === other.squadronId &&
        run.revision === other.revision &&
        run.gateRevision === other.gateRevision &&
        run.status === other.status &&
        run.updatedAt === other.updatedAt &&
        run.title === other.title &&
        run.phase === other.phase
      );
    })
  )
    return previous;
  listCache.set(key, next);
  return next;
};

const sameBoardAction = (left: BoardCard["actions"][number], right: BoardCard["actions"][number]) =>
  left.actionId === right.actionId &&
  left.phase === right.phase &&
  left.task === right.task &&
  left.attempt === right.attempt &&
  left.actionKind === right.actionKind &&
  left.actionStatus === right.actionStatus &&
  left.deadline === right.deadline &&
  left.threadId === right.threadId &&
  left.sessionRunId === right.sessionRunId &&
  left.sessionStatus === right.sessionStatus &&
  left.requestedAt === right.requestedAt &&
  left.completedAt === right.completedAt;

const sameBoardCard = (left: BoardCard, right: BoardCard) =>
  left.id === right.id &&
  left.squadronId === right.squadronId &&
  left.title === right.title &&
  left.phase === right.phase &&
  left.status === right.status &&
  left.revision === right.revision &&
  left.readVersion === right.readVersion &&
  left.gateRevision === right.gateRevision &&
  left.updatedAt === right.updatedAt &&
  left.definitionId === right.definitionId &&
  left.definitionVersion === right.definitionVersion &&
  left.definitionHash === right.definitionHash &&
  left.visit === right.visit &&
  left.failureCategory === right.failureCategory &&
  Object.keys(left.visits).length === Object.keys(right.visits).length &&
  Object.entries(left.visits).every(([phase, visits]) => right.visits[phase] === visits) &&
  left.actions.length === right.actions.length &&
  left.actions.every((action, index) => {
    const other = right.actions[index];
    return other !== undefined && sameBoardAction(action, other);
  });

export const retainBoardReference = (key: string, next: BoardPage) => {
  const previous = boardCache.get(key);
  if (previous === undefined) {
    boardCache.set(key, next);
    return next;
  }
  const cards = next.cards.map((card, index) => {
    const prior = previous.cards[index];
    return prior !== undefined && sameBoardCard(prior, card) ? prior : card;
  });
  if (
    previous.total === next.total &&
    previous.waitingApprovalCount === next.waitingApprovalCount &&
    previous.hasMore === next.hasMore &&
    cards.length === previous.cards.length &&
    cards.every((card, index) => card === previous.cards[index])
  )
    return previous;
  const retained = { ...next, cards };
  boardCache.set(key, retained);
  return retained;
};

export const retainTimelinePage = (key: string, next: TimelinePage) => {
  const previous = timelineCache.get(key);
  if (
    previous !== undefined &&
    previous.headRevision === next.headRevision &&
    next.readVersion <= previous.readVersion
  )
    return previous;
  timelineCache.set(key, next);
  return next;
};
export const retainNewestRunDetail = (previous: RunDetail | undefined, next: RunDetail | null) =>
  next === null || (previous !== undefined && next.readVersion <= previous.readVersion)
    ? previous
    : next;
export const shouldPollWorkflowQueries = (visibility: DocumentVisibilityState, count: number) =>
  visibility === "visible" && count > 0;
export const workflowIntervalTransition = (
  hasInterval: boolean,
  visibility: DocumentVisibilityState,
  pollableCount: number,
) => {
  const shouldRun = shouldPollWorkflowQueries(visibility, pollableCount);
  return shouldRun === hasInterval ? "keep" : shouldRun ? "start" : "stop";
};

export const workflowListQuery = Atom.family((key: string) => {
  const target = JSON.parse(key) as WorkflowQueryTarget<WorkflowListInput>;
  return markPollable(
    Atom.make(
      Effect.promise(async () => {
        const result = await listWorkflowEntries(
          target.input.squadronId,
          target.input.search,
          target.input.status,
          target.input.page * target.input.pageSize,
          target.input.pageSize,
        );
        return retainWorkflowListReference(key, result);
      }),
    ).pipe(
      Atom.swr({ staleTime: 5_000, revalidateOnMount: true }),
      Atom.setIdleTTL(5 * 60_000),
      Atom.withLabel(`j5-workflow:list:${key}`),
    ),
  );
});

export const workflowBoardQuery = Atom.family((key: string) => {
  const target = JSON.parse(key) as WorkflowQueryTarget<WorkflowListInput>;
  return markPollable(
    Atom.make(
      Effect.promise(async () =>
        retainBoardReference(
          key,
          await listWorkflowBoard(
            target.input.squadronId,
            target.input.search,
            target.input.status,
            target.input.page * target.input.pageSize,
            target.input.pageSize,
          ),
        ),
      ),
    ).pipe(
      Atom.swr({ staleTime: 5_000, revalidateOnMount: true }),
      Atom.setIdleTTL(5 * 60_000),
      Atom.withLabel(`j5-workflow:board:${key}`),
    ),
  );
});

export const workflowTimelineQuery = Atom.family((key: string) => {
  const target = JSON.parse(key) as WorkflowQueryTarget<{
    readonly runId: string;
    readonly before: number | null;
  }>;
  const atom = Atom.make(
    Effect.promise(async () =>
      retainTimelinePage(key, await readWorkflowTimeline(target.input.runId, target.input.before)),
    ),
  ).pipe(
    Atom.swr({
      staleTime: target.input.before === null ? 5_000 : Number.POSITIVE_INFINITY,
      revalidateOnMount: target.input.before === null,
    }),
    Atom.setIdleTTL(target.input.before === null ? 5 * 60_000 : 30 * 60_000),
    Atom.withLabel(`j5-workflow:timeline:${key}`),
  );
  return target.input.before === null ? markPollable(atom) : atom;
});

export const workflowDetailQuery = Atom.family((key: string) => {
  const target = JSON.parse(key) as WorkflowQueryTarget<{ readonly runId: string }>;
  return markPollable(
    Atom.make(
      Effect.promise(async () => {
        const previous = detailCache.get(key);
        const next = await readRun(target.input.runId, previous?.readVersion);
        const selected = retainNewestRunDetail(previous, next);
        if (selected === undefined)
          throw new Error("Workflow detail was not cached for 304 response");
        detailCache.set(key, selected);
        return selected;
      }),
    ).pipe(
      Atom.swr({ staleTime: 5_000, revalidateOnMount: true }),
      Atom.setIdleTTL(5 * 60_000),
      Atom.withLabel(`j5-workflow:detail:${key}`),
    ),
  );
});

export const workflowArtifactQuery = Atom.family((key: string) => {
  const target = JSON.parse(key) as WorkflowQueryTarget<{
    readonly runId: string;
    readonly artifact: ArtifactMetadata;
  }>;
  return Atom.make(
    Effect.promise(async () => {
      const cached = artifactCache.get(key);
      if (cached !== undefined) return cached;
      const artifact = await readArtifact(target.input.runId, target.input.artifact.id);
      if (artifact.hash !== target.input.artifact.hash)
        throw new Error("Workflow artifact hash changed");
      artifactCache.set(key, artifact);
      return artifact;
    }),
  ).pipe(
    Atom.swr({ staleTime: Number.POSITIVE_INFINITY, revalidateOnMount: false }),
    Atom.setIdleTTL(30 * 60_000),
    Atom.withLabel(`j5-workflow:artifact:${key}`),
  );
});

export const workflowDefinitionsQuery = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(Effect.promise(listWorkflowDefinitions)).pipe(
    Atom.swr({ staleTime: 5 * 60_000, revalidateOnMount: true }),
    Atom.setIdleTTL(5 * 60_000),
    Atom.withLabel(`j5-workflow:definitions:${environmentId}`),
  ),
);

export const workflowApprovalCountQuery = Atom.family((environmentId: EnvironmentId) =>
  markPollable(
    Atom.make(Effect.promise(readWorkflowApprovalCount)).pipe(
      Atom.swr({ staleTime: 5_000, revalidateOnMount: true }),
      Atom.setIdleTTL(5 * 60_000),
      Atom.withLabel(`j5-workflow:approval-count:${environmentId}`),
    ),
  ),
);

const subscribed = new Map<WorkflowAtom, number>();
let interval: number | undefined;
let listening = false;

const refreshSubscribed = () => {
  if (document.visibilityState !== "visible") return;
  for (const atom of subscribed.keys()) if (pollable.has(atom)) appAtomRegistry.refresh(atom);
};
const syncInterval = () => {
  const pollableCount = [...subscribed.keys()].filter((atom) => pollable.has(atom)).length;
  const transition = workflowIntervalTransition(
    interval !== undefined,
    document.visibilityState,
    pollableCount,
  );
  if (transition === "keep") return;
  window.clearInterval(interval);
  interval = transition === "start" ? window.setInterval(refreshSubscribed, 5_000) : undefined;
};
const onVisible = () => {
  if (document.visibilityState === "visible") refreshSubscribed();
  syncInterval();
};
const startListening = () => {
  if (listening) return;
  listening = true;
  window.addEventListener("focus", refreshSubscribed);
  window.addEventListener("online", refreshSubscribed);
  window.addEventListener("j5-workflows-changed", refreshSubscribed);
  document.addEventListener("visibilitychange", onVisible);
};
const stopListening = () => {
  if (!listening || subscribed.size > 0) return;
  listening = false;
  window.clearInterval(interval);
  interval = undefined;
  window.removeEventListener("focus", refreshSubscribed);
  window.removeEventListener("online", refreshSubscribed);
  window.removeEventListener("j5-workflows-changed", refreshSubscribed);
  document.removeEventListener("visibilitychange", onVisible);
};

export function refreshWorkflowQueries(): void {
  refreshSubscribed();
}

export const isPollableWorkflowAtom = (atom: WorkflowAtom) => pollable.has(atom);

export function useWorkflowQuery<A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null) {
  const selected = atom ?? emptyWorkflowQuery;
  const result = useAtomValue(selected);
  useEffect(() => {
    if (atom === null) return;
    const workflowAtom = atom as WorkflowAtom;
    subscribed.set(workflowAtom, (subscribed.get(workflowAtom) ?? 0) + 1);
    startListening();
    syncInterval();
    return () => {
      const count = subscribed.get(workflowAtom) ?? 0;
      if (count <= 1) subscribed.delete(workflowAtom);
      else subscribed.set(workflowAtom, count - 1);
      syncInterval();
      stopListening();
    };
  }, [atom]);
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
    isPending: atom !== null && result.waiting,
    refresh: () => {
      if (atom !== null) appAtomRegistry.refresh(atom);
    },
  };
}

export const workflowListAtom = (target: WorkflowQueryTarget<WorkflowListInput>) =>
  workflowListQuery(keyOf(target));
export const workflowBoardAtom = (target: WorkflowQueryTarget<WorkflowListInput>) =>
  workflowBoardQuery(keyOf(target));
export const workflowTimelineAtom = (
  target: WorkflowQueryTarget<{ readonly runId: string; readonly before: number | null }>,
) => workflowTimelineQuery(keyOf(target));
export const workflowDetailAtom = (target: WorkflowQueryTarget<{ readonly runId: string }>) =>
  workflowDetailQuery(keyOf(target));
export const workflowArtifactAtom = (
  target: WorkflowQueryTarget<{ readonly runId: string; readonly artifact: ArtifactMetadata }>,
) => workflowArtifactQuery(keyOf(target));

export const workflowArtifactsAtom = Atom.family((key: string) => {
  const target = JSON.parse(key) as WorkflowQueryTarget<{
    readonly runId: string;
    readonly artifacts: readonly ArtifactMetadata[];
  }>;
  const atoms = target.input.artifacts.map((artifact) =>
    workflowArtifactAtom({
      environmentId: target.environmentId,
      input: { runId: target.input.runId, artifact },
    }),
  );
  return Atom.make((get) => atoms.map((atom) => get(atom)));
});

export const workflowArtifactsAggregateAtom = (
  target: WorkflowQueryTarget<{
    readonly runId: string;
    readonly artifacts: readonly ArtifactMetadata[];
  }>,
) => workflowArtifactsAtom(keyOf(target));

export const workflowApprovalCountAtom = (environmentId: EnvironmentId) =>
  workflowApprovalCountQuery(environmentId);
