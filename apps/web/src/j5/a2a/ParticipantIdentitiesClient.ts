import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { readParticipantIdentities, readParticipantLabels } from "./archiveFlowClient";

export interface ParticipantIdentities {
  readonly labels: ReadonlyMap<string, string>;
  /** Agents whose thread is on the same server, keyed by participant id. */
  readonly threadIds: ReadonlyMap<string, ThreadId>;
}

const NO_IDENTITIES: ParticipantIdentities = { labels: new Map(), threadIds: new Map() };

/** One identity read for every J5 surface; unknowns deliberately stay absent. */
export function useParticipantIdentities(
  environmentId: EnvironmentId,
  participantIds: ReadonlyArray<string>,
): ParticipantIdentities {
  const key = Array.from(new Set(participantIds)).sort().join("\0");
  const [result, setResult] = useState({ key: "", identities: NO_IDENTITIES });
  useEffect(() => {
    const ids = key === "" ? [] : key.split("\0");
    if (ids.length === 0) {
      setResult({ key, identities: NO_IDENTITIES });
      return;
    }
    let active = true;
    void readParticipantIdentities(environmentId, ids).then((next) => {
      if (active) setResult({ key, identities: next });
    });
    return () => {
      active = false;
    };
  }, [environmentId, key]);
  return result.key === key ? result.identities : NO_IDENTITIES;
}

export function useParticipantLabels(
  environmentId: EnvironmentId,
  participantIds: ReadonlyArray<string>,
) {
  return useParticipantIdentities(environmentId, participantIds).labels;
}

export interface ScopedParticipantRef {
  readonly environmentId: EnvironmentId;
  readonly participantId: string;
  readonly connected: boolean;
}

/**
 * Labels for participants spread across environments, such as a merged inbox. Each environment
 * resolves its own participants once it is connected, so saved items shown while offline pick up
 * names on reconnect. Previous labels stay visible while a changed set reloads.
 */
export function useScopedParticipantLabels(refs: ReadonlyArray<ScopedParticipantRef>) {
  const key = Array.from(
    new Set(
      refs
        .filter((ref) => ref.connected)
        .map((ref) => JSON.stringify([ref.environmentId, ref.participantId])),
    ),
  )
    .sort()
    .join("\n");
  const [labels, setLabels] = useState<ReadonlyMap<EnvironmentId, ReadonlyMap<string, string>>>(
    () => new Map(),
  );
  useEffect(() => {
    const byEnvironment = new Map<EnvironmentId, Array<string>>();
    for (const entry of key === "" ? [] : key.split("\n")) {
      const [environmentId, participantId] = JSON.parse(entry) as [EnvironmentId, string];
      byEnvironment.set(environmentId, [
        ...(byEnvironment.get(environmentId) ?? []),
        participantId,
      ]);
    }
    let active = true;
    void Promise.all(
      Array.from(
        byEnvironment,
        async ([environmentId, ids]) =>
          [environmentId, await readParticipantLabels(environmentId, ids)] as const,
      ),
    ).then((entries) => {
      if (active) setLabels((current) => new Map([...current, ...entries]));
    });
    return () => {
      active = false;
    };
  }, [key]);
  return labels;
}
