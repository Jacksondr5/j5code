import {
  participantIdentitiesFromResponse,
  type ParticipantIdentities,
} from "@t3tools/client-runtime/j5/participant-identity";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { File, Paths } from "expo-file-system";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../../connection/catalog";
import { writeFileAtomically } from "../../lib/atomic-file";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentSession } from "../../state/session";
import { j5Sharing } from "../sharing/guestAccess";
import { j5Environment } from "../state";
import {
  answeredSince,
  credentialKey,
  decodeMemory,
  encodeMemory,
  observeCredential,
  rememberIdentities,
  rememberSpawned,
  retainSpawned,
  settleNames,
  type ConnectionMemory,
  type SettledNames,
} from "./memory.logic";

export interface MemorySnapshot {
  readonly memory: ConnectionMemory;
  /** Each server's names; a new map only when some server's names change. */
  readonly names: ReadonlyMap<EnvironmentId, ParticipantIdentities>;
  readonly settled: SettledNames;
  /** Servers whose last spawned-children read failed: they answer nothing until it succeeds. */
  readonly failedReads: ReadonlySet<EnvironmentId>;
}

const file = () => new File(Paths.cache, "j5-connection-memory.json");

// Read before the first list paints, so a cold start already knows what it learned last time.
const loadSaved = (): ConnectionMemory => {
  try {
    const saved = file();
    return decodeMemory(saved.exists ? saved.textSync() : null);
  } catch {
    return decodeMemory(null);
  }
};

const namesOf = (memory: ConnectionMemory) =>
  new Map([...memory].map(([environmentId, connection]) => [environmentId, connection.names]));

const loaded = loadSaved();
let snapshot: MemorySnapshot = {
  memory: loaded,
  names: namesOf(loaded),
  settled: new Map(),
  failedReads: new Set(),
};
const listeners = new Set<() => void>();
/** The credential each server's connection uses this launch. */
const credentials = new Map<EnvironmentId, string>();
/** The threads each server's lists asked about this launch; the saved file keeps only those. */
const asked = new Map<EnvironmentId, Set<ThreadId>>();
const namesInFlight = new Map<EnvironmentId, Set<string>>();

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let writing: Promise<void> = Promise.resolve();
const scheduleSave = () => {
  if (saveTimer !== null) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    // Saves follow a credential seen this launch, so the catalog has loaded: a removed server goes.
    const saved = new Set(appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.keys());
    const memory = new Map([...snapshot.memory].filter(([id]) => saved.has(id)));
    const contents = encodeMemory(retainSpawned(memory, asked));
    writing = writing.then(() => writeFileAtomically(file(), contents)).catch(() => undefined);
  }, 500);
};

const publish = (next: Partial<Omit<MemorySnapshot, "names">>) => {
  const names = next.memory === undefined ? snapshot.names : namesOf(next.memory);
  const sameNames =
    names.size === snapshot.names.size &&
    [...names].every(([environmentId, known]) => snapshot.names.get(environmentId) === known);
  snapshot = { ...snapshot, ...next, names: sameNames ? snapshot.names : names };
  if (next.memory !== undefined) scheduleSave();
  listeners.forEach((listener) => listener());
};

const without = <K, V>(map: ReadonlyMap<K, V>, key: K) => {
  const next = new Map(map);
  next.delete(key);
  return next;
};

const credentialKeysAtom = Atom.make((get) => {
  const keys = new Map<EnvironmentId, string>();
  for (const id of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    const prepared = Option.getOrNull(get(environmentSession.preparedConnectionValueAtom(id)));
    if (prepared !== null) keys.set(id, credentialKey(prepared));
  }
  return keys;
}).pipe(Atom.withLabel("mobile-j5:credential-keys"));

/**
 * Each server's connection-access answer when its credential last changed this launch. Lineage
 * waits for a newer answer, so a narrower person never sees the last person's parent.
 */
const accessBaselinesAtom = Atom.make<ReadonlyMap<EnvironmentId, unknown>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-j5:access-baselines"),
);

const accessQuery = (environmentId: EnvironmentId) =>
  j5Sharing.connectionAccessQuery({ environmentId, input: {} });

// A missing key is a connection between attempts, which keeps its credential.
appAtomRegistry.subscribe(
  credentialKeysAtom,
  (keys) => {
    let memory = snapshot.memory;
    let { settled, failedReads } = snapshot;
    const changed: Array<EnvironmentId> = [];
    for (const [environmentId, key] of keys) {
      const previous = credentials.get(environmentId);
      if (previous === key) continue;
      credentials.set(environmentId, key);
      memory = observeCredential(memory, environmentId, key);
      if (previous === undefined) continue;
      changed.push(environmentId);
      settled = without(settled, environmentId);
      failedReads = new Set([...failedReads].filter((id) => id !== environmentId));
      namesInFlight.delete(environmentId);
    }
    if (memory !== snapshot.memory) publish({ memory, settled, failedReads });
    if (changed.length === 0) return;
    const baselines = new Map(appAtomRegistry.get(accessBaselinesAtom));
    for (const environmentId of changed)
      baselines.set(environmentId, appAtomRegistry.get(accessQuery(environmentId)));
    appAtomRegistry.set(accessBaselinesAtom, baselines);
  },
  { immediate: true },
);

/**
 * Whether the server's answer about who this connection is came after its credential last
 * changed; true when it has not changed this launch.
 */
export const accessConfirmedAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const baseline = get(accessBaselinesAtom).get(environmentId);
    return baseline === undefined || answeredSince(baseline, get(accessQuery(environmentId)));
  }).pipe(Atom.withLabel(`mobile-j5:access-confirmed:${environmentId}`)),
);

/**
 * Servers whose spawned-children answer is on its way: connected, or on a first attempt, to a
 * person who reads the whole server. Elsewhere none is coming.
 */
export const answerExpectedAtom = Atom.make((get) => {
  const expected = new Set<EnvironmentId>();
  for (const id of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    const state = Option.getOrNull(AsyncResult.value(get(environmentCatalog.stateAtom(id))));
    if (state === null || get(j5Sharing.isNarrow(id))) continue;
    if (state.phase === "connected" || (state.phase === "connecting" && state.lastFailure === null))
      expected.add(id);
  }
  return expected;
}).pipe(Atom.withLabel("mobile-j5:answer-expected"));

export const connectionMemory = {
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: () => snapshot,
  credentialOf: (environmentId: EnvironmentId) => credentials.get(environmentId) ?? null,

  rememberSpawned: (
    environmentId: EnvironmentId,
    credential: string,
    requested: ReadonlyArray<ThreadId>,
    spawnedByAgent: ReadonlyArray<ThreadId>,
  ) => {
    const listed = asked.get(environmentId) ?? new Set();
    for (const threadId of requested) listed.add(threadId);
    asked.set(environmentId, listed);
    publish({
      memory: rememberSpawned(
        snapshot.memory,
        environmentId,
        credential,
        requested,
        spawnedByAgent,
      ),
      failedReads: new Set([...snapshot.failedReads].filter((id) => id !== environmentId)),
    });
  },

  spawnedReadFailed: (environmentId: EnvironmentId) => {
    if (!snapshot.failedReads.has(environmentId))
      publish({ failedReads: new Set(snapshot.failedReads).add(environmentId) });
  },

  /**
   * Reads the names of the ids on screen again, as each screen mounts or reconnects: a title can
   * change after a spawn. The remembered names stay shown meanwhile.
   */
  readNames: async (environmentId: EnvironmentId, participantIds: ReadonlyArray<string>) => {
    const credential = credentials.get(environmentId);
    if (credential === undefined) return;
    const inFlight = namesInFlight.get(environmentId) ?? new Set<string>();
    const ids = [...new Set(participantIds)].filter((id) => !inFlight.has(id));
    if (ids.length === 0) return;
    namesInFlight.set(environmentId, inFlight);
    for (const id of ids) inFlight.add(id);
    try {
      const result = await j5Environment.readParticipantIdentities.run(appAtomRegistry, {
        environmentId,
        input: { participantIds: ids },
      });
      if (credentials.get(environmentId) !== credential) return;
      // A failed read still settles, so its senders fall back to a stand-in until the next one.
      const settled = settleNames(snapshot.settled, environmentId, ids);
      if (result._tag === "Failure") return publish({ settled });
      publish({
        memory: rememberIdentities(
          snapshot.memory,
          environmentId,
          credential,
          ids,
          participantIdentitiesFromResponse(environmentId, result.value),
        ),
        settled,
      });
    } finally {
      for (const id of ids) inFlight.delete(id);
    }
  },
};
