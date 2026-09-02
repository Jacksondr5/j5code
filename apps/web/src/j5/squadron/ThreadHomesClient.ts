import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { browserCryptoLayer } from "../../cloud/dpop";
import { primaryEnvironmentHttpLayer } from "../../environments/primary/httpLayer";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";

const SquadronHome = Schema.Struct({ id: Schema.String, name: Schema.String });
const ThreadHome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("known"), squadron: SquadronHome }),
  Schema.Struct({ kind: Schema.Literal("unknown") }),
]);
const ParticipantHomeEntry = Schema.Struct({ participantId: Schema.String, home: ThreadHome });
const ParticipantHomesResponse = Schema.Struct({ entries: Schema.Array(ParticipantHomeEntry) });

export type ThreadHome = typeof ThreadHome.Type;
export type ThreadHomeEntry = { readonly threadId: ThreadId; readonly home: ThreadHome };
export type ThreadHomesScopeReadState = "ready" | "failed";

const runtime = ManagedRuntime.make(Layer.merge(primaryEnvironmentHttpLayer, browserCryptoLayer));
const ErrorResponse = Schema.Struct({ message: Schema.String });
const decodeErrorResponse = Schema.decodeUnknownOption(ErrorResponse);

export class ThreadHomesHttpError extends Schema.TaggedErrorClass<ThreadHomesHttpError>()(
  "ThreadHomesHttpError",
  { status: Schema.Number, detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const requireThreadHomesSuccess = Effect.fn("j5.threadHomesClient.requireSuccess")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  if (response.status >= 200 && response.status < 300) return response;
  const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));
  const decoded = Option.getOrUndefined(decodeErrorResponse(body));
  return yield* new ThreadHomesHttpError({
    status: response.status,
    detail: decoded?.message ?? `Could not read thread homes (HTTP ${response.status}).`,
  });
});

export const listThreadHomesEffect = Effect.fn("j5.threadHomesClient.list")(function* (
  threadIds: ReadonlyArray<ThreadId>,
) {
  const client = yield* HttpClient.HttpClient;
  const threadIdByParticipantId = new Map(
    threadIds.map((threadId) => [participantIdForThread(threadId), threadId] as const),
  );
  const request = yield* HttpClientRequest.post(
    resolvePrimaryEnvironmentHttpUrl("/api/j5/a2a/client-reads/participant-homes"),
  ).pipe(
    HttpClientRequest.bodyJson({ participantIds: Array.from(threadIdByParticipantId.keys()) }),
  );
  const response = yield* client.execute(request);
  const success = yield* requireThreadHomesSuccess(response);
  const decoded = yield* HttpClientResponse.schemaBodyJson(ParticipantHomesResponse)(success);
  return decoded.entries.flatMap((entry) => {
    const threadId = threadIdByParticipantId.get(entry.participantId);
    return threadId === undefined ? [] : [{ threadId, home: entry.home } satisfies ThreadHomeEntry];
  });
});

/** The Registrar persists this opaque participant identity at creation. */
export const participantIdForThread = (threadId: ThreadId) =>
  `agent:j5:a2a:${encodeURIComponent(threadId)}`;

const listThreadHomes = (threadIds: ReadonlyArray<ThreadId>) =>
  runtime.runPromise(listThreadHomesEffect(threadIds));

interface ThreadHomesStore {
  /**
   * The React external-store snapshot. Replacing, rather than mutating, this
   * map keeps the value React observes identical to the data Sidebar renders.
   */
  homesByThreadId: ReadonlyMap<string, ThreadHome>;
  readonly listeners: Set<() => void>;
  readonly pendingThreadIds: Set<ThreadId>;
  pendingScopeRead: boolean;
  reading: boolean;
  scopeReadState: ThreadHomesScopeReadState;
}

const threadHomesStoreKey = "__t3J5ThreadHomesStore";

const threadHomesStore = (() => {
  const target = globalThis as typeof globalThis & {
    __t3J5ThreadHomesStore?: ThreadHomesStore;
  };
  if (target[threadHomesStoreKey] !== undefined) return target[threadHomesStoreKey];
  const created: ThreadHomesStore = {
    homesByThreadId: new Map(),
    listeners: new Set(),
    pendingThreadIds: new Set(),
    pendingScopeRead: false,
    reading: false,
    scopeReadState: "ready",
  };
  target[threadHomesStoreKey] = created;
  return created;
})();

const subscribe = (listener: () => void) => {
  threadHomesStore.listeners.add(listener);
  return () => threadHomesStore.listeners.delete(listener);
};
const getSnapshot = () => threadHomesStore.homesByThreadId;
const getScopeReadStateSnapshot = () => threadHomesStore.scopeReadState;
const notify = () => {
  threadHomesStore.listeners.forEach((listener) => listener());
};

const readPendingThreadHomes = () => {
  if (threadHomesStore.reading || threadHomesStore.pendingThreadIds.size === 0) return;
  threadHomesStore.reading = true;
  const threadIds = Array.from(threadHomesStore.pendingThreadIds);
  const isScopeRead = threadHomesStore.pendingScopeRead;
  threadHomesStore.pendingThreadIds.clear();
  threadHomesStore.pendingScopeRead = false;
  void listThreadHomes(threadIds)
    .then((entries) => {
      threadHomesStore.homesByThreadId = replaceThreadHomeEntries(
        threadHomesStore.homesByThreadId,
        entries,
      );
      if (isScopeRead) threadHomesStore.scopeReadState = "ready";
    })
    // Under a selected scope, an unreadable home remains excluded rather than
    // being guessed from a project. The Sidebar names this state and can retry.
    .catch(() => {
      if (isScopeRead) threadHomesStore.scopeReadState = "failed";
    })
    .finally(() => {
      threadHomesStore.reading = false;
      notify();
      readPendingThreadHomes();
    });
};

/** A successful reread replaces a transient unknown with its Registrar home. */
export const mergeThreadHomeEntries = (
  homes: Map<string, ThreadHome>,
  entries: ReadonlyArray<ThreadHomeEntry>,
) => {
  for (const entry of entries) homes.set(entry.threadId, entry.home);
  return homes;
};

/** Replaces the rendered cache snapshot so receipt updates cannot retain a stale projection. */
export const replaceThreadHomeEntries = (
  homes: ReadonlyMap<string, ThreadHome>,
  entries: ReadonlyArray<ThreadHomeEntry>,
) => mergeThreadHomeEntries(new Map(homes), entries);

export const shouldRequestThreadHome = (home: ThreadHome | undefined, force: boolean) =>
  force || home === undefined;

/** A named scope must re-read its visible rows; zoom-out does not force a read. */
export const shouldForceThreadHomesForScope = (selectedSquadronId: string | null) =>
  selectedSquadronId !== null;

const requestThreadHomes = (
  threadIds: ReadonlyArray<ThreadId>,
  force = false,
  isScopeRead = false,
) => {
  let resetScopeReadState = false;
  for (const threadId of threadIds) {
    if (shouldRequestThreadHome(threadHomesStore.homesByThreadId.get(threadId), force))
      threadHomesStore.pendingThreadIds.add(threadId);
  }
  if (isScopeRead && threadHomesStore.pendingThreadIds.size > 0) {
    threadHomesStore.pendingScopeRead = true;
    if (threadHomesStore.scopeReadState !== "ready") {
      threadHomesStore.scopeReadState = "ready";
      resetScopeReadState = true;
    }
  }
  if (resetScopeReadState) notify();
  readPendingThreadHomes();
};

/**
 * Interactive J5 creation calls this after its launch succeeds: a row may have
 * reached the Sidebar while its durable Registrar attachment was still pending.
 */
export const refreshThreadHomes = (threadIds: ReadonlyArray<ThreadId>) =>
  requestThreadHomes(threadIds, true);

/** The scoped Sidebar retries the same opaque home read without a reload. */
export const retryScopedThreadHomes = (threadIds: ReadonlyArray<ThreadId>) =>
  requestThreadHomes(threadIds, true, true);

/** Only a named Sidebar scope turns a failed Registrar-home read into visible state. */
export function useThreadHomesScopeReadState(): ThreadHomesScopeReadState {
  return useSyncExternalStore(subscribe, getScopeReadStateSnapshot, getScopeReadStateSnapshot);
}

/** Immutable Registrar-home cache for Sidebar rows; never derives a home from project metadata. */
export function useThreadHomes(
  threadIds: ReadonlyArray<ThreadId>,
  selectedSquadronId: string | null = null,
  scopeSelectionGeneration = 0,
) {
  const key = Array.from(new Set(threadIds)).join("\0");
  const requestedThreadIds = useMemo(
    () => (key === "" ? [] : key.split("\0").map((threadId) => ThreadId.make(threadId))),
    [key],
  );
  const homesSnapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    const isScopeRead = shouldForceThreadHomesForScope(selectedSquadronId);
    requestThreadHomes(requestedThreadIds, isScopeRead, isScopeRead);
  }, [requestedThreadIds, selectedSquadronId, scopeSelectionGeneration]);
  return useMemo(
    () =>
      new Map(
        requestedThreadIds.flatMap((threadId) => {
          const home = homesSnapshot.get(threadId);
          return home === undefined ? [] : [[threadId, home] as const];
        }),
      ),
    [homesSnapshot, requestedThreadIds],
  );
}
