import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { credentialMissingError } from "@t3tools/client-runtime/connection";

import {
  answeredSince,
  answerOnItsWay,
  credentialKey,
  crewListedThreads,
  crewListWaiting,
  decodeMemory,
  encodeMemory,
  observeCredential,
  pendingParticipants,
  rememberIdentities,
  rememberSpawned,
  settleNames,
  type ConnectionMemory,
} from "./memory.logic";

const server = EnvironmentId.make("server-1");
const owner = "bearer:owner";
const viewer = "bearer:viewer";
const id = (value: string) => ThreadId.make(value);
const row = (threadId: string, pinnedAt: string | null = null) => ({
  environmentId: server,
  id: id(threadId),
  archivedAt: null,
  pinnedAt,
});
const titles = (threads: ReadonlyArray<{ readonly id: ThreadId }>) =>
  threads.map((thread) => thread.id);
const answering = new Set([server]);
const nobodyAnswering = new Set<EnvironmentId>();

/** What a launch remembers after one spawned-children read answered for these threads. */
const heard = (spawned: ReadonlyArray<string>, notSpawned: ReadonlyArray<string>) =>
  rememberSpawned(
    observeCredential(new Map(), server, owner),
    server,
    owner,
    [...spawned, ...notSpawned].map(id),
    spawned.map(id),
  );

describe("crewListedThreads", () => {
  it("leaves spawned threads out of a cold start's first paint, from the saved answers", () => {
    const saved = encodeMemory(heard(["seat", "peer"], ["captain", "human"]));
    const threads = [row("captain"), row("seat"), row("human"), row("peer")];

    expect(titles(crewListedThreads(threads, decodeMemory(saved), answering))).toEqual([
      id("captain"),
      id("human"),
    ]);
  });

  it("holds back a thread nobody has answered for while its server's answer is on its way", () => {
    const memory = heard([], ["captain"]);
    const threads = [row("captain"), row("new-peer")];

    expect(titles(crewListedThreads(threads, memory, answering))).toEqual([id("captain")]);
    // Offline, refused or failed: no answer is coming, so the thread shows.
    expect(crewListedThreads(threads, memory, nobodyAnswering)).toBe(threads);
    // A first launch or new pairing has nothing saved: every row waits for the first answer.
    expect(crewListedThreads(threads, new Map(), answering)).toEqual([]);
  });

  it("calls a first launch's list loading until the first answer, and empty only when it is", () => {
    const threads = [row("captain"), row("seat")];

    expect(crewListWaiting(threads, new Map(), answering)).toBe(true);
    expect(crewListWaiting(threads, new Map(), nobodyAnswering)).toBe(false);
    // Every thread was spawned: the list is truly empty, not loading.
    expect(crewListWaiting(threads, heard(["captain", "seat"], []), answering)).toBe(false);
    expect(crewListWaiting(threads, heard([], ["captain"]), answering)).toBe(false);
  });

  it("keeps the Captain listed through a spawn, and the new agent never shows", () => {
    const threads = [row("captain"), row("new-peer")];
    const before = heard([], ["captain"]);
    const after = rememberSpawned(
      before,
      server,
      owner,
      [id("captain"), id("new-peer")],
      [id("new-peer")],
    );

    expect(titles(crewListedThreads(threads, before, answering))).toEqual([id("captain")]);
    expect(titles(crewListedThreads(threads, after, answering))).toEqual([id("captain")]);
  });

  it("lists a pinned spawned thread, even before anyone answers for it", () => {
    const threads = [
      row("pinned-seat", "2026-11-19T00:00:00.000Z"),
      row("seat"),
      row("pinned-new-seat", "2026-11-19T00:00:00.000Z"),
    ];
    const memory = heard(["seat", "pinned-seat"], []);

    expect(titles(crewListedThreads(threads, memory, answering))).toEqual([
      id("pinned-seat"),
      id("pinned-new-seat"),
    ]);
  });
});

describe("participant names", () => {
  const names = (memory: ConnectionMemory) => memory.get(server)?.names.labels;
  const named = (labels: ReadonlyArray<readonly [string, string]>) => ({
    labels: new Map(labels),
    threads: new Map(),
  });

  it("keeps the names on screen when a new sender's name arrives", () => {
    const first = rememberIdentities(
      observeCredential(new Map(), server, owner),
      server,
      owner,
      ["agent:a"],
      named([["agent:a", "Sender A"]]),
    );
    const second = rememberIdentities(first, server, owner, ["agent:b"], named([["agent:b", "B"]]));

    expect(names(second)).toEqual(
      new Map([
        ["agent:a", "Sender A"],
        ["agent:b", "B"],
      ]),
    );
  });

  it("survives a reconnect and a cold start on the same credential", () => {
    const memory = rememberIdentities(
      heard(["seat"], []),
      server,
      owner,
      ["agent:a"],
      named([["agent:a", "Sender A"]]),
    );

    expect(observeCredential(memory, server, owner)).toBe(memory);
    const restored = observeCredential(decodeMemory(encodeMemory(memory)), server, owner);
    expect(names(restored)).toEqual(new Map([["agent:a", "Sender A"]]));
    expect(restored.get(server)?.spawned.get(id("seat"))).toBe(true);
  });

  it("drops what the last person heard as soon as another person pairs, and their late answers", () => {
    const memory = rememberIdentities(
      heard(["seat"], []),
      server,
      owner,
      ["agent:captain"],
      named([["agent:captain", "Captain"]]),
    );
    const repaired = observeCredential(memory, server, viewer);

    expect(names(repaired)).toEqual(new Map());
    expect(repaired.get(server)?.spawned.size).toBe(0);
    const late = rememberIdentities(
      repaired,
      server,
      owner,
      ["agent:captain"],
      named([["agent:captain", "Captain"]]),
    );
    expect(late).toBe(repaired);
  });
});

describe("pendingParticipants", () => {
  const names = new Map([
    [server, { labels: new Map([["agent:a", "Sender A"]]), threads: new Map() }],
  ]);

  it("says a new sender's name is on its way until a read settles, even a failed one", () => {
    const ids = ["agent:a", "agent:b"];

    expect([...pendingParticipants(names, new Map(), server, ids, true)]).toEqual(["agent:b"]);
    const failed = settleNames(new Map(), server, ["agent:b"]);
    expect(pendingParticipants(names, failed, server, ids, true).size).toBe(0);
    // Offline, no read is coming: the stand-in shows.
    expect(pendingParticipants(names, new Map(), server, ids, false).size).toBe(0);
  });

  it("counts a re-pair's first connection as an answer on its way, and a retry after a failure not", () => {
    const failure = credentialMissingError("connection-1");

    expect(answerOnItsWay({ phase: "connected", lastFailure: null })).toBe(true);
    expect(answerOnItsWay({ phase: "connecting", lastFailure: null })).toBe(true);
    expect(answerOnItsWay({ phase: "connecting", lastFailure: failure })).toBe(false);
    expect(answerOnItsWay({ phase: "backoff", lastFailure: failure })).toBe(false);
    expect(answerOnItsWay(null)).toBe(false);
  });
});

describe("credentialKey", () => {
  const prepared = (token: string, address = "https://server-1") => ({
    httpAuthorization: { _tag: "Bearer" as const, token },
    target: { environmentId: server, address },
  });

  it("tells two pairings apart without keeping the token", () => {
    const first = credentialKey(prepared("secret-token-one"));

    expect(first).toBe(credentialKey(prepared("secret-token-one")));
    expect(first).not.toBe(credentialKey(prepared("secret-token-two")));
    expect(first).not.toContain("secret");
  });

  it("keeps a server's names through a learned route, and drops them on a re-pair", () => {
    const named = rememberIdentities(
      observeCredential(new Map(), server, credentialKey(prepared("owner-token"))),
      server,
      credentialKey(prepared("owner-token")),
      ["agent:captain"],
      { labels: new Map([["agent:captain", "Captain"]]), threads: new Map() },
    );
    // A learned route replaces the saved entry but keeps the paired token.
    const rerouted = credentialKey(prepared("owner-token", "http://100.64.0.7:3773"));
    expect(observeCredential(named, server, rerouted)).toBe(named);
    // Re-pairing stores another token: the last person's names go at once.
    const repaired = observeCredential(named, server, credentialKey(prepared("viewer-token")));
    expect(repaired.get(server)?.names.labels.size).toBe(0);
  });
});

describe("answeredSince", () => {
  it("waits for the access answer the new connection settles, even when it reuses the value", () => {
    const owner = { kind: "person", wide: true };
    const baseline = AsyncResult.success(owner);

    expect(answeredSince(baseline, baseline)).toBe(false);
    expect(answeredSince(baseline, AsyncResult.success(owner, { waiting: true }))).toBe(false);
    expect(answeredSince(baseline, AsyncResult.success(owner))).toBe(true);
  });

  it("does not take a failed read as the answer", () => {
    const baseline = AsyncResult.success({ kind: "person", wide: true });

    expect(answeredSince(baseline, AsyncResult.fail(new Error("refused")))).toBe(false);
  });
});
