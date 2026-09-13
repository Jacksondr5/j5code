import { expect, it, vi } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ThreadHomeEntry } from "@t3tools/contracts/j5";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";
import { createThreadHomesStore } from "./threadHomes.ts";

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

function waitForChange(store: ReturnType<typeof createThreadHomesStore>, ready: () => boolean) {
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
