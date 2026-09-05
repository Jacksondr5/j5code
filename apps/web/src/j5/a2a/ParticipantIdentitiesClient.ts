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
