import { useAtomValue } from "@effect/atom-react";
import type { Artifact, ArtifactMetadata, RunDetail } from "@j5/playbook-contracts";
import { PlaybookEntries } from "@j5/playbook-contracts/sidebar";
import type { BoardCard } from "@j5/playbook-contracts/observability";
import { BoardPage, TimelinePage } from "@j5/playbook-contracts/observability";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { formatEnvironmentQueryError } from "../../state/query";
import {
  listPlaybookDefinitions,
  listPlaybookBoard,
  listPlaybookEntries,
  readArtifact,
  readRun,
  readPlaybookApprovalCount,
  readPlaybookTimeline,
} from "./client";

export interface PlaybookListInput {
  readonly squadronId: string;
  readonly search: string;
  readonly status: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface PlaybookQueryTarget<Input> {
  readonly environmentId: EnvironmentId;
  readonly input: Input;
}

const keyOf = <Input>(target: PlaybookQueryTarget<Input>) => JSON.stringify(target);
const listCache = new Map<string, typeof PlaybookEntries.Type>();
const boardCache = new Map<string, BoardPage>();
const timelineCache = new Map<string, TimelinePage>();
const detailCache = new Map<string, RunDetail>();
const artifactCache = new Map<string, Artifact>();
const emptyPlaybookQuery = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("j5-playbook:empty"),
);
type PlaybookAtom = Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>;
const pollable = new WeakSet<PlaybookAtom>();
const markPollable = <A extends PlaybookAtom>(atom: A): A => {
  pollable.add(atom);
  return atom;
};

export const retainPlaybookListReference = (key: string, next: typeof PlaybookEntries.Type) => {
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
export const shouldPollPlaybookQueries = (visibility: DocumentVisibilityState, count: number) =>
  visibility === "visible" && count > 0;
export const playbookIntervalTransition = (
  hasInterval: boolean,
  visibility: DocumentVisibilityState,
  pollableCount: number,
) => {
  const shouldRun = shouldPollPlaybookQueries(visibility, pollableCount);
  return shouldRun === hasInterval ? "keep" : shouldRun ? "start" : "stop";
};

export const playbookListQuery = Atom.family((key: string) => {
  const target = JSON.parse(key) as PlaybookQueryTarget<PlaybookListInput>;
  return markPollable(
    Atom.make(
      Effect.promise(async () => {
        const result = await listPlaybookEntries(
          target.input.squadronId,
          target.input.search,
          target.input.status,
          target.input.page * target.input.pageSize,
          target.input.pageSize,
        );
        return retainPlaybookListReference(key, result);
      }),
    ).pipe(
      Atom.swr({ staleTime: 5_000, revalidateOnMount: true }),
      Atom.setIdleTTL(5 * 60_000),
      Atom.withLabel(`j5-playbook:list:${key}`),
    ),
  );
});

export const playbookBoardQuery = Atom.family((key: string) => {
  const target = JSON.parse(key) as PlaybookQueryTarget<PlaybookListInput>;
  return markPollable(
    Atom.make(
      Effect.promise(async () =>
        retainBoardReference(
          key,
          await listPlaybookBoard(
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
      Atom.withLabel(`j5-playbook:board:${key}`),
    ),
  );
});

export const playbookTimelineQuery = Atom.family((key: string) => {
  const target = JSON.parse(key) as PlaybookQueryTarget<{
    readonly runId: string;
    readonly before: number | null;
  }>;
  const atom = Atom.make(
    Effect.promise(async () =>
      retainTimelinePage(key, await readPlaybookTimeline(target.input.runId, target.input.before)),
    ),
  ).pipe(
    Atom.swr({
      staleTime: target.input.before === null ? 5_000 : Number.POSITIVE_INFINITY,
      revalidateOnMount: target.input.before === null,
    }),
    Atom.setIdleTTL(target.input.before === null ? 5 * 60_000 : 30 * 60_000),
    Atom.withLabel(`j5-playbook:timeline:${key}`),
  );
  return target.input.before === null ? markPollable(atom) : atom;
});

export const playbookDetailQuery = Atom.family((key: string) => {
  const target = JSON.parse(key) as PlaybookQueryTarget<{ readonly runId: string }>;
  return markPollable(
    Atom.make(
      Effect.promise(async () => {
        const previous = detailCache.get(key);
        const next = await readRun(target.input.runId, previous?.readVersion);
        const selected = retainNewestRunDetail(previous, next);
        if (selected === undefined)
          throw new Error("Playbook detail was not cached for 304 response");
        detailCache.set(key, selected);
        return selected;
      }),
    ).pipe(
      Atom.swr({ staleTime: 5_000, revalidateOnMount: true }),
      Atom.setIdleTTL(5 * 60_000),
      Atom.withLabel(`j5-playbook:detail:${key}`),
    ),
  );
});

export const playbookArtifactQuery = Atom.family((key: string) => {
  const target = JSON.parse(key) as PlaybookQueryTarget<{
    readonly runId: string;
    readonly artifact: ArtifactMetadata;
  }>;
  return Atom.make(
    Effect.promise(async () => {
      const cached = artifactCache.get(key);
      if (cached !== undefined) return cached;
      const artifact = await readArtifact(target.input.runId, target.input.artifact.id);
      if (artifact.hash !== target.input.artifact.hash)
        throw new Error("Playbook artifact hash changed");
      artifactCache.set(key, artifact);
      return artifact;
    }),
  ).pipe(
    Atom.swr({ staleTime: Number.POSITIVE_INFINITY, revalidateOnMount: false }),
    Atom.setIdleTTL(30 * 60_000),
    Atom.withLabel(`j5-playbook:artifact:${key}`),
  );
});

export const playbookDefinitionsQuery = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(Effect.promise(listPlaybookDefinitions)).pipe(
    Atom.swr({ staleTime: 5 * 60_000, revalidateOnMount: true }),
    Atom.setIdleTTL(5 * 60_000),
    Atom.withLabel(`j5-playbook:definitions:${environmentId}`),
  ),
);

export const playbookApprovalCountQuery = Atom.family((environmentId: EnvironmentId) =>
  markPollable(
    Atom.make(Effect.promise(readPlaybookApprovalCount)).pipe(
      Atom.swr({ staleTime: 5_000, revalidateOnMount: true }),
      Atom.setIdleTTL(5 * 60_000),
      Atom.withLabel(`j5-playbook:approval-count:${environmentId}`),
    ),
  ),
);

const subscribed = new Map<PlaybookAtom, number>();
let interval: number | undefined;
let listening = false;

const refreshSubscribed = () => {
  if (document.visibilityState !== "visible") return;
  for (const atom of subscribed.keys()) if (pollable.has(atom)) appAtomRegistry.refresh(atom);
};
const syncInterval = () => {
  const pollableCount = [...subscribed.keys()].filter((atom) => pollable.has(atom)).length;
  const transition = playbookIntervalTransition(
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
  window.addEventListener("j5-playbooks-changed", refreshSubscribed);
  document.addEventListener("visibilitychange", onVisible);
};
const stopListening = () => {
  if (!listening || subscribed.size > 0) return;
  listening = false;
  window.clearInterval(interval);
  interval = undefined;
  window.removeEventListener("focus", refreshSubscribed);
  window.removeEventListener("online", refreshSubscribed);
  window.removeEventListener("j5-playbooks-changed", refreshSubscribed);
  document.removeEventListener("visibilitychange", onVisible);
};

export function refreshPlaybookQueries(): void {
  refreshSubscribed();
}

export const isPollablePlaybookAtom = (atom: PlaybookAtom) => pollable.has(atom);

export function usePlaybookQuery<A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null) {
  const selected = atom ?? emptyPlaybookQuery;
  const result = useAtomValue(selected);
  useEffect(() => {
    if (atom === null) return;
    const playbookAtom = atom as PlaybookAtom;
    subscribed.set(playbookAtom, (subscribed.get(playbookAtom) ?? 0) + 1);
    startListening();
    syncInterval();
    return () => {
      const count = subscribed.get(playbookAtom) ?? 0;
      if (count <= 1) subscribed.delete(playbookAtom);
      else subscribed.set(playbookAtom, count - 1);
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

export const playbookListAtom = (target: PlaybookQueryTarget<PlaybookListInput>) =>
  playbookListQuery(keyOf(target));
export const playbookBoardAtom = (target: PlaybookQueryTarget<PlaybookListInput>) =>
  playbookBoardQuery(keyOf(target));
export const playbookTimelineAtom = (
  target: PlaybookQueryTarget<{ readonly runId: string; readonly before: number | null }>,
) => playbookTimelineQuery(keyOf(target));
export const playbookDetailAtom = (target: PlaybookQueryTarget<{ readonly runId: string }>) =>
  playbookDetailQuery(keyOf(target));
export const playbookArtifactAtom = (
  target: PlaybookQueryTarget<{ readonly runId: string; readonly artifact: ArtifactMetadata }>,
) => playbookArtifactQuery(keyOf(target));

export const playbookArtifactsAtom = Atom.family((key: string) => {
  const target = JSON.parse(key) as PlaybookQueryTarget<{
    readonly runId: string;
    readonly artifacts: readonly ArtifactMetadata[];
  }>;
  const atoms = target.input.artifacts.map((artifact) =>
    playbookArtifactAtom({
      environmentId: target.environmentId,
      input: { runId: target.input.runId, artifact },
    }),
  );
  return Atom.make((get) => atoms.map((atom) => get(atom)));
});

export const playbookArtifactsAggregateAtom = (
  target: PlaybookQueryTarget<{
    readonly runId: string;
    readonly artifacts: readonly ArtifactMetadata[];
  }>,
) => playbookArtifactsAtom(keyOf(target));

export const playbookApprovalCountAtom = (environmentId: EnvironmentId) =>
  playbookApprovalCountQuery(environmentId);
