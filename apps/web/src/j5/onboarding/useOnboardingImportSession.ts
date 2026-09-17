import type { CommandId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";
import { useCallback, useState } from "react";

import type {
  OnboardingFolderOutcome,
  OnboardingSquadronHome,
  OnboardingSquadronRow,
} from "./onboardingSquadrons.logic";

/**
 * Retry memory for the final import run. Held by the wizard, not the step, so going back
 * through Projects, Providers, or Connect and returning never forgets a project already
 * created, a Squadron already minted, or the stable command ids that make retries idempotent.
 * Everything here is written only by the run itself.
 */
export interface OnboardingImportMemory {
  /** Folders whose import fully landed, keyed by candidate key. */
  readonly importedProjects: Map<string, ScopedProjectRef>;
  /** Folders whose import brought in at least one conversation. */
  readonly projectsWithImportedHistory: Map<string, ScopedProjectRef>;
  /** Project ids and command ids fixed on the first attempt so a retry replays them. */
  readonly projectAttempts: Map<
    string,
    { readonly projectId: ProjectId; readonly commandId: CommandId }
  >;
  /** The Squadron each row settled on, keyed by row id. Never created twice, never inferred. */
  readonly homes: Map<string, OnboardingSquadronHome>;
  /** The Squadron that received each folder's import, keyed by folder; the landing draft uses it. */
  readonly recipients: Map<string, OnboardingSquadronHome>;
  /** Folders whose results report kept conversations; the wizard waits for a click before leaving. */
  readonly keptFolders: Set<string>;
}

export interface OnboardingImportSession {
  /** `null` until the person touches the list, so the scan's default selection applies. */
  readonly selectedKeys: ReadonlySet<string> | null;
  readonly setSelectedKeys: (next: ReadonlySet<string>) => void;
  /** Squadron rows per folder; a folder absent here has its one default row. */
  readonly rows: ReadonlyMap<string, ReadonlyArray<OnboardingSquadronRow>>;
  readonly setRows: (key: string, rows: ReadonlyArray<OnboardingSquadronRow>) => void;
  /** Definite create rejections per row, cleared when the row runs again. */
  readonly rowErrors: ReadonlyMap<string, string>;
  readonly setRowError: (rowId: string, message: string | null) => void;
  readonly outcomes: ReadonlyMap<string, OnboardingFolderOutcome>;
  readonly setOutcome: (key: string, outcome: OnboardingFolderOutcome) => void;
  readonly memory: OnboardingImportMemory;
}

/** One session per wizard mount. Entries for unchecked folders stay put, so reselecting restores them. */
export function useOnboardingImportSession(): OnboardingImportSession {
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string> | null>(null);
  const [rows, setRowsState] = useState<ReadonlyMap<string, ReadonlyArray<OnboardingSquadronRow>>>(
    () => new Map(),
  );
  const [rowErrors, setRowErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, OnboardingFolderOutcome>>(
    () => new Map(),
  );
  const [memory] = useState<OnboardingImportMemory>(() => ({
    importedProjects: new Map(),
    projectsWithImportedHistory: new Map(),
    projectAttempts: new Map(),
    homes: new Map(),
    recipients: new Map(),
    keptFolders: new Set(),
  }));
  const setRows = useCallback((key: string, next: ReadonlyArray<OnboardingSquadronRow>) => {
    setRowsState((current) => new Map(current).set(key, next));
  }, []);
  const setRowError = useCallback((rowId: string, message: string | null) => {
    setRowErrors((current) => {
      if (message === null && !current.has(rowId)) return current;
      const next = new Map(current);
      if (message === null) next.delete(rowId);
      else next.set(rowId, message);
      return next;
    });
  }, []);
  const setOutcome = useCallback((key: string, outcome: OnboardingFolderOutcome) => {
    setOutcomes((current) => new Map(current).set(key, outcome));
  }, []);
  return {
    selectedKeys,
    setSelectedKeys,
    rows,
    setRows,
    rowErrors,
    setRowError,
    outcomes,
    setOutcome,
    memory,
  };
}
