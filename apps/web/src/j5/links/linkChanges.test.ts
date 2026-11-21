import { EnvironmentId, type PeerLinkCreateInput, type PeerLinkSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { PeerRecord } from "../peering/peeringClient";
import {
  applyLevelChange,
  planLevelChange,
  removalOf,
  removePair,
  type LinkOps,
} from "./linkChanges";
import { linkPairs, type LinkPair, type ManagedLinkList } from "./linkPairs";

const HOME = EnvironmentId.make("environment-home");
const WORK = EnvironmentId.make("environment-work");

const record = (environmentId: string, label: string, fields: Partial<PeerRecord> = {}) =>
  ({
    environmentId,
    label,
    linkMode: "push",
    origin: `https://${label.toLowerCase()}.example`,
    lineAddress: null,
    lastError: null,
    ...fields,
  }) as PeerRecord;

const link = (environmentId: EnvironmentId, label: string): PeerLinkSummary => ({
  environmentId,
  label,
  urls: [`https://${label.toLowerCase()}.linked`],
  access: "approval-required",
  linkedAt: DateTime.makeUnsafe("2026-11-01T00:00:00.000Z"),
  expiresAt: DateTime.makeUnsafe("2026-12-01T00:00:00.000Z"),
  lastReachedAt: null,
  lastError: null,
  status: "reachable",
});

const home = (fields: Partial<ManagedLinkList> = {}): ManagedLinkList => ({
  environmentId: HOME,
  label: "Home",
  peers: [record(WORK, "Work")],
  links: [],
  ...fields,
});
const work = (fields: Partial<ManagedLinkList> = {}): ManagedLinkList => ({
  environmentId: WORK,
  label: "Work",
  peers: [record(HOME, "Home")],
  links: [],
  ...fields,
});

const pairOf = (...lists: ReadonlyArray<ManagedLinkList>): LinkPair => linkPairs(lists)[0]!;
const sideOf = (pair: LinkPair, id: EnvironmentId) =>
  pair.sides.find((side) => side.environmentId === id)!;

const allOn = () => ({ linkedEnvironmentsEnabled: true });

/** Records each call in order; `fail` names the calls that throw. */
const recordingOps = (fail: ReadonlyArray<string> = []) => {
  const calls: Array<string> = [];
  const links: Array<PeerLinkCreateInput> = [];
  const run = (call: string) => {
    calls.push(call);
    if (fail.includes(call)) throw new Error(`${call} failed`);
  };
  const ops: LinkOps = {
    enableLinkedEnvironments: async (id) => run(`enable ${id}`),
    mintPairingCode: async (id, access) => {
      run(`mint ${id} ${access}`);
      return "code";
    },
    link: async (holder, input) => {
      run(`link ${holder}`);
      links.push(input);
    },
    forget: async (holder, other) => {
      run(`forget ${holder} ${other}`);
      return { detail: holder === WORK ? "Home kept the session." : null };
    },
    removePeer: async (holder, other) => run(`removePeer ${holder} ${other}`),
  };
  return { calls, links, ops };
};

describe("planLevelChange", () => {
  it("links at the address the holder's messages already take, and names the servers to turn on", () => {
    const pair = pairOf(home(), work());
    expect(
      planLevelChange({
        pair,
        holder: sideOf(pair, HOME),
        level: "auto",
        factsOf: (id) => ({ linkedEnvironmentsEnabled: id === HOME }),
      }),
    ).toEqual({
      kind: "link",
      level: "auto",
      urls: ["https://work.example"],
      turnOn: [sideOf(pair, WORK)],
    });
  });

  it("reaches a poller through its line, and says so when the poller has not connected yet", () => {
    const storing = (lineAddress: string | null) =>
      pairOf(
        home({ peers: [record(WORK, "Work", { linkMode: "poll" })] }),
        work({ peers: [record(HOME, "Home", { linkMode: "store", origin: null, lineAddress })] }),
      );
    const up = storing("http://127.77.0.1:1");
    expect(
      planLevelChange({ pair: up, holder: sideOf(up, WORK), level: "read-only", factsOf: allOn }),
    ).toMatchObject({ kind: "link", urls: ["http://127.77.0.1:1"], turnOn: [] });

    const never = storing(null);
    expect(
      planLevelChange({
        pair: never,
        holder: sideOf(never, WORK),
        level: "read-only",
        factsOf: allOn,
      }),
    ).toMatchObject({ kind: "blocked" });
  });

  it("keeps a link's own addresses when the pair has no messaging, and a moved address wins", () => {
    const toolsOnly = pairOf(home({ peers: [], links: [link(WORK, "Work")] }), work({ peers: [] }));
    expect(
      planLevelChange({
        pair: toolsOnly,
        holder: sideOf(toolsOnly, HOME),
        level: "auto",
        factsOf: allOn,
      }),
    ).toMatchObject({ kind: "link", urls: ["https://work.linked"] });
    expect(
      planLevelChange({
        pair: toolsOnly,
        holder: sideOf(toolsOnly, WORK),
        level: "auto",
        factsOf: allOn,
      }),
      "nothing says where Work would reach Home",
    ).toMatchObject({ kind: "blocked" });

    const pair = pairOf(home(), work());
    expect(
      planLevelChange({
        pair,
        holder: sideOf(pair, HOME),
        level: "auto",
        factsOf: allOn,
        address: "https://work.moved",
      }),
    ).toMatchObject({ kind: "link", urls: ["https://work.moved"] });
  });

  it("needs the holder to forget a link, and both servers to make one", () => {
    const pair = pairOf(home());
    const [mine, theirs] = [sideOf(pair, HOME), sideOf(pair, WORK)];
    expect(planLevelChange({ pair, holder: mine, level: "off", factsOf: allOn })).toEqual({
      kind: "off",
    });
    expect(planLevelChange({ pair, holder: mine, level: "auto", factsOf: allOn })).toMatchObject({
      kind: "blocked",
    });
    expect(planLevelChange({ pair, holder: theirs, level: "off", factsOf: allOn })).toMatchObject({
      kind: "blocked",
    });
  });
});

describe("applyLevelChange", () => {
  it("turns the setting on, mints on the other server, then links on the holder", async () => {
    const pair = pairOf(home(), work());
    const holder = sideOf(pair, HOME);
    const { calls, links, ops } = recordingOps();
    const plan = planLevelChange({
      pair,
      holder,
      level: "auto",
      factsOf: () => ({ linkedEnvironmentsEnabled: false }),
    });
    if (plan.kind === "blocked") throw new Error(plan.reason);

    expect(await applyLevelChange({ pair, holder, plan, ops })).toEqual({ ok: true, note: null });
    expect(calls).toEqual([
      `enable ${HOME}`,
      `enable ${WORK}`,
      `mint ${WORK} auto`,
      `link ${HOME}`,
    ]);
    expect(links).toEqual([
      {
        url: "https://work.example",
        expectedEnvironmentId: WORK,
        expectedLabel: "Work",
        pairingCode: "code",
        access: "auto",
      },
    ]);
  });

  it("stops at the step that fails, and passes on why a session was left", async () => {
    const pair = pairOf(home(), work({ links: [link(HOME, "Home")] }));
    const failing = recordingOps([`mint ${WORK} auto`]);
    const holder = sideOf(pair, HOME);
    const plan = planLevelChange({ pair, holder, level: "auto", factsOf: allOn });
    if (plan.kind === "blocked") throw new Error(plan.reason);
    expect(await applyLevelChange({ pair, holder, plan, ops: failing.ops })).toEqual({
      ok: false,
      reason: `mint ${WORK} auto failed`,
    });
    expect(failing.calls, "nothing is linked with no code").toEqual([`mint ${WORK} auto`]);

    const { ops } = recordingOps();
    expect(
      await applyLevelChange({ pair, holder: sideOf(pair, WORK), plan: { kind: "off" }, ops }),
    ).toEqual({ ok: true, note: "Home kept the session." });
  });
});

describe("removePair", () => {
  it("forgets every link before it removes any peer, on each side this client manages", async () => {
    const pair = pairOf(
      home({ links: [link(WORK, "Work")] }),
      work({ links: [link(HOME, "Home")] }),
    );
    const { calls, ops } = recordingOps();
    expect(await removePair(pair, ops)).toEqual({
      failures: [],
      notes: ["Home kept the session."],
    });
    expect(calls).toEqual([
      `forget ${HOME} ${WORK}`,
      `forget ${WORK} ${HOME}`,
      `removePeer ${HOME} ${WORK}`,
      `removePeer ${WORK} ${HOME}`,
    ]);
  });

  it("tries every side and step when one fails, and skips what a side does not hold", async () => {
    const pair = pairOf(home({ links: [link(WORK, "Work")] }), work());
    const { calls, ops } = recordingOps([`forget ${HOME} ${WORK}`]);
    const outcome = await removePair(pair, ops);
    expect(calls).toEqual([
      `forget ${HOME} ${WORK}`,
      `removePeer ${HOME} ${WORK}`,
      `removePeer ${WORK} ${HOME}`,
    ]);
    expect(outcome.failures.map(({ side, reason }) => [side.label, reason])).toEqual([
      ["Home", `forget ${HOME} ${WORK} failed`],
    ]);

    const unread = pairOf(home(), work({ peers: null, links: null }));
    const second = recordingOps();
    await removePair(unread, second.ops);
    expect(second.calls, "a server that could not be read may still hold its part").toEqual([
      `forget ${WORK} ${HOME}`,
      `removePeer ${HOME} ${WORK}`,
      `removePeer ${WORK} ${HOME}`,
    ]);
  });
});

describe("removalOf", () => {
  it("is both when the other server can be removed too, here only when it cannot", () => {
    expect(removalOf(pairOf(home(), work())).kind).toBe("both");
    expect(removalOf(pairOf(home())).kind).toBe("here-only");
    expect(
      removalOf(pairOf(home(), work({ peers: [] }))),
      "the other server already holds nothing",
    ).toMatchObject({ kind: "ended", holder: { label: "Home" }, other: { label: "Work" } });

    const toolsOnly = pairOf(home({ peers: [], links: [link(WORK, "Work")] }));
    expect(
      removalOf(toolsOnly),
      "a pair with only a link is removed from its holder",
    ).toMatchObject({ kind: "here-only", holder: { label: "Home" } });
  });
});
