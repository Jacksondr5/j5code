import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { CrewArchiveWorktreeEstimate, PreArchiveFacts } from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { j5Environment } from "../state";

export type { PreArchiveFacts, PreArchiveLiveCrew as LiveCrew } from "@t3tools/contracts/j5";

/** Unknown participants stay absent, and so does every one when the read fails. */
export async function readParticipantIdentities(
  environmentId: EnvironmentId,
  participantIds: ReadonlyArray<string>,
) {
  const labels = new Map<string, string>();
  const threads = new Map<string, ScopedThreadRef>();
  if (participantIds.length === 0) return { labels, threads };
  const result = await j5Environment.readParticipantIdentities.run(appAtomRegistry, {
    environmentId,
    input: { participantIds },
  });
  if (result._tag === "Failure") return { labels, threads };
  for (const entry of result.value.entries) {
    const identity = entry.identity;
    if (identity.kind !== "known") continue;
    labels.set(entry.participantId, identity.displayName);
    if (identity.threadId === undefined) continue;
    const home =
      identity.threadEnvironmentId === undefined
        ? environmentId
        : EnvironmentId.make(identity.threadEnvironmentId);
    threads.set(entry.participantId, scopeThreadRef(home, ThreadId.make(identity.threadId)));
  }
  return { labels, threads };
}

export async function readParticipantLabels(
  environmentId: EnvironmentId,
  participantIds: ReadonlyArray<string>,
) {
  return (await readParticipantIdentities(environmentId, participantIds)).labels;
}

export interface ArchivePreflight {
  readonly facts: PreArchiveFacts | null;
  readonly participantLabels: ReadonlyMap<string, string>;
  /**
   * What archiving the Crews the thread commands would do with their seats' worktrees; null when
   * that couldn't be read. Absent when the thread commands no Crew.
   */
  readonly worktrees?: ReadonlyArray<CrewArchiveWorktreeEstimate> | null;
}

/** The worktree estimate for these Crews, or null when the read failed: "couldn't check". */
export async function readCrewArchiveWorktrees(
  environmentId: EnvironmentId,
  crewInstanceIds: ReadonlyArray<string>,
): Promise<ReadonlyArray<CrewArchiveWorktreeEstimate> | null> {
  const result = await j5Environment.readCrewArchiveWorktrees.run(appAtomRegistry, {
    environmentId,
    input: { crewInstanceIds },
  });
  return result._tag === "Failure" ? null : result.value.worktrees;
}

/** Facts remain useful without identity labels; literal participant ids are the honest fallback. */
export async function readArchivePreflight(threadRef: ScopedThreadRef): Promise<ArchivePreflight> {
  const result = await j5Environment.readPreArchiveFacts.run(appAtomRegistry, {
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId },
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  const facts = result.value;
  if (facts.state !== "registered") return { facts, participantLabels: new Map() };
  const ids = Array.from(
    new Set([
      ...facts.openExchanges.map((exchange) => exchange.counterpartyId),
      ...(facts.placementSubtree.state === "known" ? facts.placementSubtree.participantIds : []),
      ...(facts.liveCrews ?? []).flatMap((crew) => crew.seats.map((seat) => seat.participantId)),
    ]),
  );
  const crewIds = (facts.liveCrews ?? []).map((crew) => crew.crewInstanceId);
  const [participantLabels, worktrees] = await Promise.all([
    readParticipantLabels(threadRef.environmentId, ids),
    crewIds.length === 0 ? undefined : readCrewArchiveWorktrees(threadRef.environmentId, crewIds),
  ]);
  return { facts, participantLabels, ...(worktrees === undefined ? {} : { worktrees }) };
}
