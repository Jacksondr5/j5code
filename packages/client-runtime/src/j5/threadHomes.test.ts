import { expect, it, vi } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ThreadHomeEntry } from "@t3tools/contracts/j5";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";
import {
  THREAD_READ_BATCH_SIZE,
  createScopedThreadReadStore,
  createThreadHomesStore,
} from "./threadHomes.ts";

const alpha = EnvironmentId.make("alpha");
const bravo = EnvironmentId.make("bravo");
const threadId = ThreadId.make("thread:shared");
const key = (environmentId: EnvironmentId) =>
  scopedThreadKey(scopeThreadRef(environmentId, threadId));
const ref = (environmentId: EnvironmentId) => scopeThreadRef(environmentId, threadId);
const prepared = (environmentId: EnvironmentId): PreparedConnection => ({
  environmentId,
  label: environmentId,
  httpBaseUrl: `https://${environmentId}.test`,
  socketUrl: `wss://${environmentId}.test/ws`,
  httpAuthorization: null,
  target: new PrimaryConnectionTarget({
    environmentId,
    label: environmentId,
    httpBaseUrl: `https://${environmentId}.test`,
    wsBaseUrl: `wss://${environmentId}.test`,
  }),
});
const home = (name: string): ThreadHomeEntry => ({
  threadId,
  home: { kind: "known", squadron: { id: `squadron:${name}`, name } },
});

function waitForChange(
  store: { readonly subscribe: (listener: () => void) => () => void },
  ready: () => boolean,
) {
  if (ready()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const unsubscribe = store.subscribe(() => {
      if (ready()) {
        unsubscribe();
        resolve();
      }
    });
  });
}

it("batches and caches homes in each environment without mixing the same local thread ID", async () => {
  const load = vi.fn(async (connection: PreparedConnection) => [home(connection.environmentId)]);
  const store = createThreadHomesStore(load);
  store.setConnections(
    new Map([
      [alpha, prepared(alpha)],
      [bravo, prepared(bravo)],
    ]),
  );
  store.request([ref(alpha), ref(alpha), ref(bravo)]);
  store.request([ref(alpha), ref(bravo)]);
  await waitForChange(store, () => store.getSnapshot().size === 2);
  expect(load.mock.calls).toHaveLength(2);
  expect(store.getSnapshot().get(key(alpha))).toEqual(home("alpha").home);
  expect(store.getSnapshot().get(key(bravo))).toEqual(home("bravo").home);
  store.request([ref(alpha), ref(bravo)]);
  expect(load.mock.calls).toHaveLength(2);
});

it("re-reads after reconnection and discards a late response from the previous connection", async () => {
  const old = Promise.withResolvers<ReadonlyArray<ThreadHomeEntry>>();
  const load = vi
    .fn<
      (
        _: PreparedConnection,
        ids: ReadonlyArray<ThreadId>,
      ) => Promise<ReadonlyArray<ThreadHomeEntry>>
    >()
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce([home("new")]);
  const store = createThreadHomesStore(load);
  store.setConnections(new Map([[alpha, prepared(alpha)]]));
  store.request([ref(alpha)]);
  store.setConnections(new Map([[alpha, null]]));
  store.setConnections(new Map([[alpha, prepared(alpha)]]));
  await waitForChange(store, () => store.getSnapshot().get(key(alpha))?.kind === "known");
  old.resolve([home("old")]);
  await old.promise;
  expect(store.getSnapshot().get(key(alpha))).toEqual(home("new").home);
});

it("removing an environment clears its homes and prevents an in-flight read from restoring them", async () => {
  const pending = Promise.withResolvers<ReadonlyArray<ThreadHomeEntry>>();
  const store = createThreadHomesStore(() => pending.promise);
  store.setConnections(new Map([[alpha, prepared(alpha)]]));
  store.request([ref(alpha)]);
  store.setConnections(new Map());
  pending.resolve([home("removed")]);
  await pending.promise;
  expect(store.getSnapshot().size).toBe(0);
});

it("retains cached homes through a failed refresh and clears the failure after an explicit retry", async () => {
  const load = vi
    .fn<
      (
        _: PreparedConnection,
        ids: ReadonlyArray<ThreadId>,
      ) => Promise<ReadonlyArray<ThreadHomeEntry>>
    >()
    .mockResolvedValueOnce([home("alpha")])
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValueOnce([home("alpha")]);
  const store = createThreadHomesStore(load);
  store.setConnections(new Map([[alpha, prepared(alpha)]]));
  store.request([ref(alpha)]);
  await waitForChange(store, () => store.getSnapshot().size === 1);
  const initial = store.getSnapshot();
  store.request([ref(alpha)], true);
  await waitForChange(store, () => store.getScopeReadState(alpha) === "failed");
  expect(store.getSnapshot()).toBe(initial);
  store.request([ref(alpha)], true);
  await waitForChange(store, () => store.getScopeReadState(alpha) === "ready");
  expect(load.mock.calls).toHaveLength(3);
});

it("reads a large request in batches under the route cap and stays unchunked below it", async () => {
  const loads: Array<number> = [];
  const store = createThreadHomesStore((_, ids) => {
    loads.push(ids.length);
    return Promise.resolve(
      ids.map((id) => ({
        threadId: id,
        home: { kind: "known" as const, squadron: { id: "squadron:big", name: "Big" } },
      })),
    );
  });
  store.setConnections(new Map([[alpha, prepared(alpha)]]));
  const refs = Array.from({ length: THREAD_READ_BATCH_SIZE * 2 + 50 }, (_, index) =>
    scopeThreadRef(alpha, ThreadId.make(`thread:${index}`)),
  );
  store.request(refs);
  await waitForChange(store, () => store.getSnapshot().size === refs.length);
  expect(loads).toEqual([THREAD_READ_BATCH_SIZE, THREAD_READ_BATCH_SIZE, 50]);
});

it("keeps a negative answer loaded, re-reads only named rows, and keeps the snapshot when nothing changed", async () => {
  const one = ThreadId.make("thread:one");
  const two = ThreadId.make("thread:two");
  const load = vi.fn(async (_: PreparedConnection, ids: ReadonlyArray<ThreadId>) =>
    // Only `one` sits in a Crew; `two` is answered with nothing, which is an answer too.
    ids.includes(one) ? [{ threadId: one, value: "seat" }] : [],
  );
  const store = createScopedThreadReadStore<string, { threadId: ThreadId; value: string }>({
    load,
    replace: (current, environmentId, requested, entries) => {
      const next = new Map(current);
      for (const id of requested) next.delete(scopedThreadKey(scopeThreadRef(environmentId, id)));
      for (const entry of entries)
        next.set(scopedThreadKey(scopeThreadRef(environmentId, entry.threadId)), entry.value);
      return next;
    },
  });
  store.setConnections(new Map([[alpha, prepared(alpha)]]));
  store.request([scopeThreadRef(alpha, one), scopeThreadRef(alpha, two)]);
  await waitForChange(store, () => store.getSnapshot().size === 1);
  expect(load.mock.calls).toHaveLength(1);
  const first = store.getSnapshot();
  // The requested set reorders and shrinks; the negative for `two` is not fetched again.
  store.request([scopeThreadRef(alpha, two), scopeThreadRef(alpha, one)]);
  store.request([scopeThreadRef(alpha, two)]);
  expect(load.mock.calls).toHaveLength(1);
  // The poll names the involved row only; the read carries just that id and, being unchanged,
  // leaves the same snapshot in place so no subscriber re-renders.
  let notified = 0;
  store.subscribe(() => {
    notified += 1;
  });
  store.refreshRows([scopeThreadRef(alpha, one), scopeThreadRef(bravo, one)]);
  await waitForChange(store, () => notified > 0);
  expect(load.mock.calls).toHaveLength(2);
  expect(load.mock.calls[1]?.[1]).toEqual([one]);
  expect(store.getSnapshot()).toBe(first);
  // A row nobody asked for is not read on the poll's say-so.
  store.refreshRows([scopeThreadRef(alpha, ThreadId.make("thread:unrequested"))]);
  expect(load.mock.calls).toHaveLength(2);
});

it("re-reads the rows still holding a value on a held refresh, so an ended relation clears", async () => {
  const one = ThreadId.make("thread:one");
  const two = ThreadId.make("thread:two");
  let crews: ReadonlyArray<ThreadId> = [one];
  const load = vi.fn(async (_: PreparedConnection, ids: ReadonlyArray<ThreadId>) =>
    ids.filter((id) => crews.includes(id)).map((id) => ({ threadId: id, value: "seat" })),
  );
  const store = createScopedThreadReadStore<string, { threadId: ThreadId; value: string }>({
    load,
    replace: (current, environmentId, requested, entries) => {
      const next = new Map(current);
      for (const id of requested) next.delete(scopedThreadKey(scopeThreadRef(environmentId, id)));
      for (const entry of entries)
        next.set(scopedThreadKey(scopeThreadRef(environmentId, entry.threadId)), entry.value);
      return next;
    },
  });
  store.setConnections(new Map([[alpha, prepared(alpha)]]));
  store.request([scopeThreadRef(alpha, one), scopeThreadRef(alpha, two)]);
  await waitForChange(store, () => store.getSnapshot().size === 1);
  // The Crew retires elsewhere: the live roster names nobody, yet `one` still shows its chip. The
  // held refresh re-reads it, and only it, and the chip clears.
  crews = [];
  let reads = 0;
  store.subscribe(() => {
    reads += 1;
  });
  store.refreshRows([], { held: true });
  await waitForChange(store, () => reads > 0);
  expect(load.mock.calls).toHaveLength(2);
  expect(load.mock.calls[1]?.[1]).toEqual([one]);
  expect(store.getSnapshot().size).toBe(0);
  // Nothing holds a value now, so a held refresh with no named rows reads nothing at all.
  store.refreshRows([], { held: true });
  expect(load.mock.calls).toHaveLength(2);
});
