import {
  participantIdentitiesFromResponse,
  type ParticipantIdentities,
} from "@t3tools/client-runtime/j5/participant-identity";
import {
  CredentialStore,
  credentialConnectionId,
  EnvironmentRegistry,
} from "@t3tools/client-runtime/connection";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { File, Paths } from "expo-file-system";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { environmentCatalog } from "../../connection/catalog";
import { connectionAtomRuntime } from "../../connection/runtime";
import { writeFileAtomically } from "../../lib/atomic-file";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentSession } from "../../state/session";
import { j5Sharing } from "../sharing/guestAccess";
import { j5Environment } from "../state";
import {
  answeredSince,
  answerOnItsWay,
  createCredentialTickets,
  credentialKey,
  decodeMemory,
  encodeMemory,
  observeCredential,
  rememberIdentities,
  rememberSpawned,
  retainSpawned,
  settleNames,
  type ConnectionMemory,
  type CredentialTicket,
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
  } catch (cause) {
    console.warn("J5 could not read its saved connection memory", cause);
    return decodeMemory(null);
  }
};

type MemoryState = Omit<MemorySnapshot, "names">;

const namesOf = (memory: ConnectionMemory) =>
  new Map([...memory].map(([environmentId, connection]) => [environmentId, connection.names]));

let state: MemoryState = { memory: loadSaved(), settled: new Map(), failedReads: new Set() };
let snapshot: MemorySnapshot = { ...state, names: namesOf(state.memory) };
const listeners = new Set<() => void>();
const tickets = createCredentialTickets();
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
    const memory = new Map([...state.memory].filter(([id]) => saved.has(id)));
    const contents = encodeMemory(retainSpawned(memory, asked));
    writing = writing
      .then(() => writeFileAtomically(file(), contents))
      .catch((cause) => console.warn("J5 could not save its connection memory", cause));
  }, 500);
};

const publish = (next: Partial<MemoryState>) => {
  state = { ...state, ...next };
  const names = namesOf(state.memory);
  const sameNames =
    names.size === snapshot.names.size &&
    [...names].every(([environmentId, known]) => snapshot.names.get(environmentId) === known);
  snapshot = { ...state, names: sameNames ? snapshot.names : names };
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

/** Lineage on these servers waits for an access answer newer than the one they hold now. */
const awaitNewAccess = (environmentIds: ReadonlyArray<EnvironmentId>) => {
  if (environmentIds.length === 0) return;
  const baselines = new Map(appAtomRegistry.get(accessBaselinesAtom));
  for (const environmentId of environmentIds)
    baselines.set(environmentId, appAtomRegistry.get(accessQuery(environmentId)));
  appAtomRegistry.set(accessBaselinesAtom, baselines);
};

/** A server moves to a credential; a different one is another person, who starts with nothing. */
const applyCredential = (environmentId: EnvironmentId, key: string) => {
  const previous = tickets.move(environmentId, key);
  if (previous === null) return;
  const memory = observeCredential(state.memory, environmentId, key);
  if (previous === undefined) {
    if (memory !== state.memory) publish({ memory });
    return;
  }
  namesInFlight.delete(environmentId);
  publish({
    memory,
    settled: without(state.settled, environmentId),
    failedReads: new Set([...state.failedReads].filter((id) => id !== environmentId)),
  });
  awaitNewAccess([environmentId]);
};

// A missing key is a connection between attempts, which keeps its credential.
appAtomRegistry.subscribe(
  credentialKeysAtom,
  (keys) => keys.forEach((key, environmentId) => applyCredential(environmentId, key)),
  { immediate: true },
);

/** The credential a saved server's entry now pairs with, read from the device's store. */
const storedCredentialKey = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile-j5:stored-credential-key",
  execute: Effect.fn("j5.connectionMemory.storedCredentialKey")(function* (
    environmentId: EnvironmentId,
  ) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const entry = (yield* SubscriptionRef.get(registry.entries)).get(environmentId);
    if (entry?.target._tag !== "BearerConnectionTarget") return null;
    const store = yield* CredentialStore.ConnectionCredentialStore;
    const stored = yield* store.get(credentialConnectionId(entry.target.connectionId));
    return Option.match(stored, {
      onNone: () => null,
      onSome: (credential) =>
        credentialKey({
          httpAuthorization: { _tag: "Bearer", token: credential.token },
          target: entry.target,
        }),
    });
  }),
});

const entries = new Map<EnvironmentId, unknown>();
// Re-pairing stores a new token and replaces the server's entry at once, while its connection
// reports the credential only once it opens. A learned route replaces the entry but keeps the token.
appAtomRegistry.subscribe(
  environmentCatalog.catalogValueAtom,
  (catalog) => {
    for (const [environmentId, entry] of catalog.entries) {
      const previous = entries.get(environmentId);
      entries.set(environmentId, entry);
      if (previous === undefined || previous === entry) continue;
      void storedCredentialKey.run(appAtomRegistry, environmentId).then((result) => {
        if (result._tag === "Success" && result.value !== null)
          applyCredential(environmentId, result.value);
      });
    }
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
  for (const id of get(namesExpectedAtom)) if (!get(j5Sharing.isNarrow(id))) expected.add(id);
  return expected;
}).pipe(Atom.withLabel("mobile-j5:answer-expected"));

/** Servers that refuse this person the spawned-children read: they reach less than the server. */
export const narrowServersAtom = Atom.make((get) => {
  const narrow = new Set<EnvironmentId>();
  for (const id of get(environmentCatalog.catalogValueAtom).entries.keys())
    if (get(j5Sharing.isNarrow(id))) narrow.add(id);
  return narrow;
}).pipe(Atom.withLabel("mobile-j5:narrow-servers"));

/** Servers whose answers are on its way to anyone, a narrower person's name reads included. */
export const namesExpectedAtom = Atom.make((get) => {
  const expected = new Set<EnvironmentId>();
  for (const id of get(environmentCatalog.catalogValueAtom).entries.keys())
    if (answerOnItsWay(Option.getOrNull(AsyncResult.value(get(environmentCatalog.stateAtom(id))))))
      expected.add(id);
  return expected;
}).pipe(Atom.withLabel("mobile-j5:names-expected"));

export const connectionMemory = {
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: () => snapshot,
  /** The ticket a read carries out and hands back with its answer. */
  ticketOf: (environmentId: EnvironmentId) => tickets.current(environmentId),

  rememberSpawned: (
    environmentId: EnvironmentId,
    ticket: CredentialTicket,
    requested: ReadonlyArray<ThreadId>,
    spawnedByAgent: ReadonlyArray<ThreadId>,
  ) => {
    if (!tickets.isCurrent(environmentId, ticket)) return;
    const listed = asked.get(environmentId) ?? new Set();
    for (const threadId of requested) listed.add(threadId);
    asked.set(environmentId, listed);
    publish({
      memory: rememberSpawned(state.memory, environmentId, ticket.key, requested, spawnedByAgent),
      failedReads: new Set([...state.failedReads].filter((id) => id !== environmentId)),
    });
  },

  spawnedReadFailed: (environmentId: EnvironmentId) => {
    if (!state.failedReads.has(environmentId))
      publish({ failedReads: new Set(state.failedReads).add(environmentId) });
  },

  /**
   * Reads the names of the ids on screen again, as each screen mounts or reconnects: a title can
   * change after a spawn. The remembered names stay shown meanwhile.
   */
  readNames: async (environmentId: EnvironmentId, participantIds: ReadonlyArray<string>) => {
    const ticket = tickets.current(environmentId);
    if (ticket === null) return;
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
      if (!tickets.isCurrent(environmentId, ticket)) return;
      // A failed read still settles, so its senders fall back to a stand-in until the next one.
      const settled = settleNames(state.settled, environmentId, ids);
      if (result._tag === "Failure") return publish({ settled });
      publish({
        memory: rememberIdentities(
          state.memory,
          environmentId,
          ticket.key,
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
