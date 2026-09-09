import { useAtomValue } from "@effect/atom-react";
import type { Artifact, ArtifactMetadata, RunDetail } from "@j5/workflow-contracts";
import { WorkflowEntries } from "@j5/workflow-contracts/sidebar";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { formatEnvironmentQueryError } from "../../state/query";
import {
  listWorkflowDefinitions,
  listWorkflowEntries,
  readArtifact,
  readRun,
  readWorkflowApprovalCount,
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
