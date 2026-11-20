import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { isSidebarMember } from "@t3tools/client-runtime/j5/spawned-children";
import type { ParticipantIdentities } from "@t3tools/client-runtime/j5/participant-identity";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import type { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";

/** What this device last heard on one server under one paired credential. */
export interface RememberedConnection {
  readonly credential: string;
  /** Threads the spawned-children read answered for: true when an agent spawned the thread. */
  readonly spawned: ReadonlyMap<ThreadId, boolean>;
  /** Kept apart from `spawned`, so a classification never re-renders a feed that reads names. */
  readonly names: ParticipantIdentities;
}

export type ConnectionMemory = ReadonlyMap<EnvironmentId, RememberedConnection>;

const NO_NAMES: ParticipantIdentities = { labels: new Map(), threads: new Map() };

/** FNV-1a, so the saved file names a credential without holding its token. */
const fingerprint = (text: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
};

/**
 * The paired credential a connection uses: its bearer token, which re-pairing replaces and a
 * reconnect keeps. A connection without one is known by its route.
 */
export const credentialKey = (prepared: {
  readonly httpAuthorization: PreparedConnection["httpAuthorization"];
  readonly target: unknown;
}) =>
  prepared.httpAuthorization?._tag === "Bearer"
    ? `bearer:${fingerprint(prepared.httpAuthorization.token)}`
    : `route:${fingerprint(JSON.stringify(prepared.target))}`;

const emptyConnection = (credential: string): RememberedConnection => ({
  credential,
  spawned: new Map(),
  names: NO_NAMES,
});

/** A different credential is a different person: nothing heard under the old one carries over. */
export const observeCredential = (
  memory: ConnectionMemory,
  environmentId: EnvironmentId,
  credential: string,
): ConnectionMemory =>
  memory.get(environmentId)?.credential === credential
    ? memory
    : new Map(memory).set(environmentId, emptyConnection(credential));

/** An answer read under another credential than the remembered one is dropped. */
const updateConnection = (
  memory: ConnectionMemory,
  environmentId: EnvironmentId,
  credential: string,
  update: (connection: RememberedConnection) => RememberedConnection,
): ConnectionMemory => {
  const connection = memory.get(environmentId) ?? emptyConnection(credential);
  if (connection.credential !== credential) return memory;
  return new Map(memory).set(environmentId, update(connection));
};

/** The read's answer for the threads it was asked about; a thread it does not name was not spawned. */
export const rememberSpawned = (
  memory: ConnectionMemory,
  environmentId: EnvironmentId,
  credential: string,
  requested: ReadonlyArray<ThreadId>,
  spawnedByAgent: ReadonlyArray<ThreadId>,
): ConnectionMemory =>
  updateConnection(memory, environmentId, credential, (connection) => {
    const named = new Set(spawnedByAgent);
    const spawned = new Map(connection.spawned);
    for (const threadId of requested) spawned.set(threadId, named.has(threadId));
    return { ...connection, spawned };
  });

/** Names read for some participants join the known ones; one the server no longer names is dropped. */
export const rememberIdentities = (
  memory: ConnectionMemory,
  environmentId: EnvironmentId,
  credential: string,
  requested: ReadonlyArray<string>,
  identities: ParticipantIdentities,
): ConnectionMemory =>
  updateConnection(memory, environmentId, credential, (connection) => {
    const labels = new Map(connection.names.labels);
    const threads = new Map(connection.names.threads);
    for (const participantId of requested) {
      labels.delete(participantId);
      threads.delete(participantId);
    }
    for (const [participantId, label] of identities.labels) labels.set(participantId, label);
    for (const [participantId, thread] of identities.threads) threads.set(participantId, thread);
    return { ...connection, names: { labels, threads } };
  });

/** Only the threads still listed keep their answer, so the saved file follows the lists. */
export const retainSpawned = (
  memory: ConnectionMemory,
  keep: ReadonlyMap<EnvironmentId, ReadonlySet<ThreadId>>,
): ConnectionMemory =>
  new Map(
    [...memory].map(([environmentId, connection]) => {
      const listed = keep.get(environmentId);
      if (listed === undefined) return [environmentId, connection];
      const spawned = new Map([...connection.spawned].filter(([threadId]) => listed.has(threadId)));
      return [environmentId, { ...connection, spawned }];
    }),
  );

const StoredMemory = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    environments: Schema.Array(
      Schema.Tuple([
        EnvironmentId,
        Schema.Struct({
          credential: Schema.String,
          spawned: Schema.Array(ThreadId),
          notSpawned: Schema.Array(ThreadId),
          labels: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
          threads: Schema.Array(Schema.Tuple([Schema.String, EnvironmentId, ThreadId])),
        }),
      ]),
    ),
  }),
);
const encodeStored = Schema.encodeSync(StoredMemory);
const decodeStored = Schema.decodeUnknownOption(StoredMemory);

export const encodeMemory = (memory: ConnectionMemory): string =>
  encodeStored({
    version: 1,
    environments: [...memory].map(([environmentId, connection]) => [
      environmentId,
      {
        credential: connection.credential,
        spawned: [...connection.spawned].flatMap(([id, spawned]) => (spawned ? [id] : [])),
        notSpawned: [...connection.spawned].flatMap(([id, spawned]) => (spawned ? [] : [id])),
        labels: [...connection.names.labels],
        threads: [...connection.names.threads].map(([participantId, ref]) => [
          participantId,
          ref.environmentId,
          ref.threadId,
        ]),
      },
    ]),
  });

/** A file this version cannot read is an empty memory: it is only a head start. */
export const decodeMemory = (raw: string | null): ConnectionMemory => {
  const stored = raw === null ? Option.none() : decodeStored(raw);
  if (Option.isNone(stored)) return new Map();
  return new Map(
    stored.value.environments.map(([environmentId, connection]) => [
      environmentId,
      {
        credential: connection.credential,
        spawned: new Map([
          ...connection.spawned.map((id) => [id, true] as const),
          ...connection.notSpawned.map((id) => [id, false] as const),
        ]),
        names: {
          labels: new Map(connection.labels),
          threads: new Map(
            connection.threads.map(([participantId, home, threadId]) => [
              participantId,
              { environmentId: home, threadId } satisfies ScopedThreadRef,
            ]),
          ),
        },
      },
    ]),
  );
};

export interface ListedThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly archivedAt: string | null;
  readonly pinnedAt?: string | null | undefined;
}

/**
 * The list's threads without the ones an agent spawned (register D22). A thread its server has
 * not answered for yet waits while the answer is on its way, so it never shows and then leaves.
 * Where no answer is coming (offline, a narrower person, a failed read) it shows.
 */
export function crewListedThreads<T extends ListedThread>(
  threads: ReadonlyArray<T>,
  memory: ConnectionMemory,
  answerExpected: ReadonlySet<EnvironmentId>,
): ReadonlyArray<T> {
  const listed = threads.filter((thread) => {
    if (thread.archivedAt !== null || thread.pinnedAt != null) return true;
    const spawned = memory.get(thread.environmentId)?.spawned.get(thread.id);
    if (spawned === undefined) return !answerExpected.has(thread.environmentId);
    return isSidebarMember(thread, spawned);
  });
  // The same array when nothing was dropped, so the list's own memos keep their values.
  return listed.length === threads.length ? threads : listed;
}

/**
 * Whether a query has settled again since `baseline`, its value when the credential changed: a
 * later settled result came over the new connection, even when it reuses the old value.
 */
export const answeredSince = (
  baseline: unknown,
  result: AsyncResult.AsyncResult<unknown, unknown>,
) => result !== baseline && result._tag !== "Initial" && !result.waiting;

/** The participants a name read has settled for, per server, under its current credential. */
export type SettledNames = ReadonlyMap<EnvironmentId, ReadonlySet<string>>;

export const settleNames = (
  settled: SettledNames,
  environmentId: EnvironmentId,
  participantIds: ReadonlyArray<string>,
): SettledNames =>
  new Map(settled).set(
    environmentId,
    new Set([...(settled.get(environmentId) ?? []), ...participantIds]),
  );

const NO_ONE: ReadonlySet<string> = new Set();

/**
 * Ids whose name is on its way: their connected server has no remembered name for them and no
 * read has settled. A screen says nothing for them rather than a stand-in it would replace.
 */
export const pendingParticipants = (
  memory: ConnectionMemory,
  settled: SettledNames,
  environmentId: EnvironmentId,
  participantIds: ReadonlyArray<string>,
  connected: boolean,
): ReadonlySet<string> => {
  if (!connected) return NO_ONE;
  const done = settled.get(environmentId);
  const labels = memory.get(environmentId)?.names.labels;
  const pending = participantIds.filter((id) => !done?.has(id) && !labels?.has(id));
  return pending.length === 0 ? NO_ONE : new Set(pending);
};

/** Whether the list is empty only because every live thread waits for its first answer. */
export function crewListWaiting(
  threads: ReadonlyArray<ListedThread>,
  memory: ConnectionMemory,
  answerExpected: ReadonlySet<EnvironmentId>,
): boolean {
  const live = threads.filter((thread) => thread.archivedAt === null);
  if (live.length === 0) return false;
  if (crewListedThreads(live, memory, answerExpected).length > 0) return false;
  return live.some(
    (thread) =>
      answerExpected.has(thread.environmentId) &&
      memory.get(thread.environmentId)?.spawned.get(thread.id) === undefined,
  );
}
