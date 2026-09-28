import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { readParticipantLabels } from "./archiveFlowClient";

/** One identity read for every J5 surface; unknowns deliberately stay absent. */
export function useParticipantLabels(
  environmentId: EnvironmentId,
  participantIds: ReadonlyArray<string>,
) {
  const key = Array.from(new Set(participantIds)).sort().join("\0");
  const [result, setResult] = useState({ key: "", labels: new Map<string, string>() });
  useEffect(() => {
    const ids = key === "" ? [] : key.split("\0");
    if (ids.length === 0) {
      setResult({ key, labels: new Map() });
      return;
    }
    let active = true;
    void readParticipantLabels(environmentId, ids).then((next) => {
      if (active) setResult({ key, labels: next });
    });
    return () => {
      active = false;
    };
  }, [environmentId, key]);
  return useMemo(() => (result.key === key ? result.labels : new Map()), [key, result]);
}

export interface ScopedParticipantRef {
  readonly environmentId: EnvironmentId;
  readonly participantId: string;
}

/**
 * Labels for participants spread across environments, such as a merged inbox. Each environment
 * resolves its own participants. The previous labels stay visible while a changed set reloads.
 */
export function useScopedParticipantLabels(refs: ReadonlyArray<ScopedParticipantRef>) {
  const key = Array.from(
    new Set(refs.map((ref) => JSON.stringify([ref.environmentId, ref.participantId]))),
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
      if (active) setLabels(new Map(entries));
    });
    return () => {
      active = false;
    };
  }, [key]);
  return labels;
}
