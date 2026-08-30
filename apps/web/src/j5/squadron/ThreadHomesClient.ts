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
const ThreadHomeEntry = Schema.Struct({ threadId: ThreadId, home: ThreadHome });
const ThreadHomesResponse = Schema.Struct({ entries: Schema.Array(ThreadHomeEntry) });

export type ThreadHome = typeof ThreadHome.Type;
export type ThreadHomeEntry = typeof ThreadHomeEntry.Type;

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
  const request = yield* HttpClientRequest.post(
    resolvePrimaryEnvironmentHttpUrl("/api/j5/a2a/thread-homes"),
  ).pipe(HttpClientRequest.bodyJson({ threadIds }));
  const response = yield* client.execute(request);
  const success = yield* requireThreadHomesSuccess(response);
  return (yield* HttpClientResponse.schemaBodyJson(ThreadHomesResponse)(success)).entries;
});

const listThreadHomes = (threadIds: ReadonlyArray<ThreadId>) =>
  runtime.runPromise(listThreadHomesEffect(threadIds));

const homesByThreadId = new Map<string, ThreadHome>();
const listeners = new Set<() => void>();
const pendingThreadIds = new Set<ThreadId>();
let reading = false;
let version = 0;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const getVersion = () => version;
const notify = () => {
  version += 1;
  listeners.forEach((listener) => listener());
};

const readPendingThreadHomes = () => {
  if (reading || pendingThreadIds.size === 0) return;
  reading = true;
  const threadIds = Array.from(pendingThreadIds);
  pendingThreadIds.clear();
  void listThreadHomes(threadIds)
    .then((entries) => {
      mergeThreadHomeEntries(homesByThreadId, entries);
    })
    // Under a selected scope, an unreadable home remains excluded rather than
    // being guessed from a project. The next changed sidebar set retries it.
    .catch(() => undefined)
    .finally(() => {
      reading = false;
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

export const shouldRequestThreadHome = (home: ThreadHome | undefined, force: boolean) =>
  force || home === undefined;

/** A named scope must re-read its visible rows; zoom-out does not force a read. */
export const shouldForceThreadHomesForScope = (selectedSquadronId: string | null) =>
  selectedSquadronId !== null;

const requestThreadHomes = (threadIds: ReadonlyArray<ThreadId>, force = false) => {
  for (const threadId of threadIds) {
    if (shouldRequestThreadHome(homesByThreadId.get(threadId), force))
      pendingThreadIds.add(threadId);
  }
  readPendingThreadHomes();
};

/**
 * Interactive J5 creation calls this after its launch succeeds: a row may have
 * reached the Sidebar while its durable Registrar attachment was still pending.
 */
export const refreshThreadHomes = (threadIds: ReadonlyArray<ThreadId>) =>
  requestThreadHomes(threadIds, true);

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
  const currentVersion = useSyncExternalStore(subscribe, getVersion, getVersion);
  useEffect(() => {
    requestThreadHomes(requestedThreadIds, shouldForceThreadHomesForScope(selectedSquadronId));
  }, [requestedThreadIds, selectedSquadronId, scopeSelectionGeneration]);
  return useMemo(
    () =>
      new Map(
        requestedThreadIds.flatMap((threadId) => {
          const home = homesByThreadId.get(threadId);
          return home === undefined ? [] : [[threadId, home] as const];
        }),
      ),
    [currentVersion, requestedThreadIds],
  );
}
