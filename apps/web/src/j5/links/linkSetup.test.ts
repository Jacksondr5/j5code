import type { PeeringChoice } from "@t3tools/client-runtime/j5/peering";
import { EnvironmentId, type PeerLinkCreateInput, type PeerLinkSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { PeeringCheck } from "../peering/peeringCheck";
import type { PeerRecord } from "../peering/peeringClient";
import { linkPairs, type ManagedLinkList } from "./linkPairs";
import {
  linkCandidateOf,
  linkPair,
  pairLevelsOf,
  pairResultOf,
  pairRouteOf,
  prepareRequestLink,
  requestLinkStateOf,
  type LinkSetupServer,
  type PairLinkOps,
  type PairLinkPlan,
} from "./linkSetup";

const LAPTOP = EnvironmentId.make("environment-laptop");
const WORK = EnvironmentId.make("environment-work");

const server = (
  environmentId: EnvironmentId,
  label: string,
  fields: Partial<LinkSetupServer> = {},
): LinkSetupServer => ({
  environmentId,
  label,
  serverVersion: "1.0.0",
  supportsPoll: true,
  runMode: "service",
  supportsLinks: true,
  linkedEnvironmentsEnabled: true,
  ...fields,
});
const laptop = server(LAPTOP, "Laptop");
const work = server(WORK, "Work");

const record = (environmentId: string, label: string, fields: Partial<PeerRecord> = {}) =>
  ({
    environmentId,
    label,
    linkMode: "push",
    origin: `https://${label.toLowerCase()}.example`,
    lineAddress: null,
    ...fields,
  }) as PeerRecord;

const link = (environmentId: EnvironmentId, label: string): PeerLinkSummary => ({
  environmentId,
  label,
  urls: [`https://${label.toLowerCase()}.linked`],
  access: "auto",
  linkedAt: DateTime.makeUnsafe("2026-11-01T00:00:00.000Z"),
  expiresAt: DateTime.makeUnsafe("2026-12-01T00:00:00.000Z"),
  lastReachedAt: null,
  lastError: null,
  status: "reachable",
});

const reached = (origin: string) => ({ kind: "reached", origin }) as const;
const failed = { kind: "failed", errors: ["ECONNREFUSED"] } as const;
const untested = { kind: "untested", error: null } as const;
const bothWays: PeeringCheck = {
  localToRemote: reached("https://work.example"),
  remoteToLocal: reached("https://laptop.example"),
};

describe("linkCandidateOf", () => {
  const candidate = (
    other: Partial<Parameters<typeof linkCandidateOf>[0]["other"]> = {},
    lists: ReadonlyArray<ManagedLinkList> = [],
  ) =>
    linkCandidateOf({
      local: laptop,
      other: {
        environmentId: WORK,
        label: "Work",
        connected: true,
        managed: true,
        server: work,
        ...other,
      },
      pair: linkPairs(lists)[0] ?? null,
    });
  const lists = (laptopList: Partial<ManagedLinkList>, workList: Partial<ManagedLinkList>) => [
    { environmentId: LAPTOP, label: "Laptop", peers: [], links: [], ...laptopList },
    { environmentId: WORK, label: "Work", peers: [], links: [], ...workList },
  ];

  it("says why a server cannot be linked from here", () => {
    expect(candidate().unavailable).toBeNull();
    expect(candidate({ connected: false }).unavailable).toBe("Not connected");
    expect(candidate({ managed: false }).unavailable).toBe("This app can't manage access there");
    expect(
      candidate({ server: server(WORK, "Work", { supportsPoll: false, supportsLinks: false }) })
        .unavailable,
    ).toBe("Update J5 on Work first");
    expect(
      candidate({}, lists({ peers: [record(WORK, "Work")] }, { peers: [record(LAPTOP, "Laptop")] }))
        .unavailable,
    ).toBe("Already linked");
    expect(
      linkCandidateOf({
        local: laptop,
        other: { environmentId: WORK, label: "Work", connected: true, managed: true, server: work },
        pair: null,
        unread: "Laptop",
      }).unavailable,
    ).toBe("Couldn't read Laptop's links");
  });

  it("links a server that does not run J5 for tools only", () => {
    const t3 = { server: server(WORK, "Work", { supportsPoll: false }) };
    expect(candidate(t3)).toMatchObject({ unavailable: null, support: "tools-only" });
    expect(candidate(t3, lists({ links: [link(WORK, "Work")] }, {})).unavailable).toBe(
      "Already linked",
    );
  });

  it("can set up messaging for a pair that only has tools, and leaves those tools as they are", () => {
    expect(candidate({}, lists({ links: [link(WORK, "Work")] }, {}))).toMatchObject({
      unavailable: null,
      messaging: false,
      localLevel: "auto",
      remoteLevel: null,
    });
  });

  it("sets a pair up again when only one server records the other, clearing that record", () => {
    expect(candidate({}, lists({}, { peers: [record(LAPTOP, "Laptop")] }))).toMatchObject({
      unavailable: null,
      messaging: false,
      clearLeftover: "remote",
    });
    // Half an introduction: this server recorded the other and the other's write failed.
    expect(candidate({}, lists({ peers: [record(WORK, "Work")] }, {}))).toMatchObject({
      unavailable: null,
      messaging: false,
      clearLeftover: "local",
    });
  });

  it("does not call a pair half recorded when it could not read one of the two", () => {
    const unread = lists({ peers: [record(WORK, "Work")] }, { peers: null });
    expect(candidate({ managed: false }, unread)).toMatchObject({
      messaging: true,
      clearLeftover: null,
    });
  });

  it("makes a link again when its session may be gone, and keeps no link that ran out", () => {
    // The other server removed its side, which revokes the sessions this server's links held there.
    expect(
      candidate({}, lists({ peers: [record(WORK, "Work")], links: [link(WORK, "Work")] }, {})),
    ).toMatchObject({ clearLeftover: "local", localLevel: null });
    expect(
      candidate({}, lists({ links: [{ ...link(WORK, "Work"), status: "expired" }] }, {})),
    ).toMatchObject({ localLevel: null });
  });
});

describe("pairLevelsOf", () => {
  const shared = { local: "off", remote: "approval-required" } as const;
  const fresh = { localLevel: null, remoteLevel: null };
  const edits = { localLevel: "full-access" } as const;

  it("uses a pair's own level only while its picker is shown", () => {
    expect(pairLevelsOf({ candidate: fresh, edits, shared, tickedCount: 2 })).toEqual({
      own: true,
      localLevel: "full-access",
      remoteLevel: "approval-required",
    });
    // The other server was unticked: the pair's picker is gone, and so is what was set in it.
    expect(pairLevelsOf({ candidate: fresh, edits, shared, tickedCount: 1 })).toEqual({
      own: false,
      localLevel: "off",
      remoteLevel: "approval-required",
    });
  });

  it("plans nothing for a direction that keeps its level, and shows the pair's own pickers", () => {
    expect(
      pairLevelsOf({
        candidate: { localLevel: "auto", remoteLevel: null },
        edits,
        shared,
        tickedCount: 1,
      }),
    ).toEqual({ own: true, localLevel: "off", remoteLevel: "approval-required" });
  });
});

describe("pairRouteOf", () => {
  const route = (
    check: PeeringCheck | null,
    edits = {},
    remote: LinkSetupServer = work,
    local: LinkSetupServer = laptop,
  ) => pairRouteOf({ local, remote, check, edits });
  const offered = (check: PeeringCheck, remote?: LinkSetupServer) =>
    route(check, {}, remote).options.map(
      (option) => `${option.connections}${option.recommended ? " (recommended)" : ""}`,
    );

  it("waits for the check", () => {
    expect(route(null)).toMatchObject({ choice: null, ready: false, line: "Checking…" });
  });

  it("recommends sending directly between two always-on servers that reach each other", () => {
    expect(offered(bothWays)).toEqual(["both (recommended)", "local-only", "remote-only"]);
    expect(route(bothWays)).toMatchObject({
      ready: true,
      line: "Messages are sent directly both ways",
      choice: { localOrigin: "https://laptop.example", remoteOrigin: "https://work.example" },
    });
  });

  it("picks polling by itself for a server that may be off, without asking", () => {
    const home = server(WORK, "Home", { runMode: "desktop" });
    expect(offered(bothWays, home)).toEqual(["both", "local-only", "remote-only (recommended)"]);
    expect(route(bothWays, {}, home).line).toBe("Home polls Laptop for messages");
  });

  it("still offers a way the check could not prove, at an address the person knows", () => {
    const oneWay = { localToRemote: reached("https://work.example"), remoteToLocal: failed };
    expect(offered(oneWay)).toEqual(["both", "local-only (recommended)", "remote-only"]);
    expect(route(oneWay).line).toBe("Laptop polls Work for messages");
    expect(route(oneWay, { connections: "both" })).toMatchObject({ ready: false });
    expect(
      route(oneWay, { connections: "both", localOrigin: "https://laptop.ts.net" }),
    ).toMatchObject({ ready: true, choice: { localOrigin: "https://laptop.ts.net" } });
  });

  it("offers sending directly at an address the person types when a direction was not tested", () => {
    const unproven = { localToRemote: reached("https://work.example"), remoteToLocal: untested };
    expect(route(unproven).options).toEqual([
      { connections: "both", recommended: false, asks: ["localOrigin"] },
      { connections: "local-only", recommended: true, asks: [] },
      { connections: "remote-only", recommended: false, asks: ["localOrigin"] },
    ]);
    expect(route(unproven, { connections: "both" })).toMatchObject({
      ready: false,
      problem: true,
      line: "Messages are sent directly both ways · needs an address",
    });
    // With Change open the field itself asks, so the line carries no error.
    expect(
      pairRouteOf({
        local: laptop,
        remote: work,
        check: unproven,
        edits: { connections: "both" },
        changing: true,
      }),
    ).toMatchObject({
      ready: false,
      problem: false,
      line: "Messages are sent directly both ways",
    });
    expect(
      route(unproven, { connections: "both", localOrigin: "https://laptop.ts.net" }),
    ).toMatchObject({ ready: true, choice: { localOrigin: "https://laptop.ts.net" } });
  });

  it("asks for another address where tools are on and the one found is plain http", () => {
    const lan = {
      localToRemote: reached("http://10.0.0.7:3773"),
      remoteToLocal: reached("https://laptop.example"),
    };
    const on = { localLevel: "auto", remoteLevel: "auto" } as const;
    const routed = (levels: Parameters<typeof pairRouteOf>[0]["levels"], edits = {}) =>
      pairRouteOf({
        local: laptop,
        remote: work,
        check: lan,
        edits: { connections: "both", ...edits },
        ...(levels === undefined ? {} : { levels }),
      });
    const refused = routed(on);
    expect(refused).toMatchObject({
      ready: false,
      problem: true,
      line: "Messages are sent directly both ways · tools need another address",
    });
    expect(refused.fields.map((field) => [field.field, field.error !== null])).toEqual([
      ["remoteOrigin", true],
    ]);
    expect(refused.fields[0]?.error).toContain("set Laptop's agents to Off");
    // Messages alone take the address, and so does a direction whose tools go another way.
    expect(routed({ localLevel: "off", remoteLevel: "auto" })).toMatchObject({
      ready: true,
      fields: [],
    });
    expect(routed(on, { connections: "remote-only" })).toMatchObject({ ready: true, fields: [] });
    // A typed address stays on its field once it is one tools can use.
    for (const remoteOrigin of ["https://work.example", "http://work.tail1234.ts.net:3773"]) {
      expect(routed(on, { remoteOrigin })).toMatchObject({
        ready: true,
        fields: [{ field: "remoteOrigin", error: null }],
      });
    }
    expect(routed(on, { remoteOrigin: "http://100.101.102.103:3773" }).ready).toBe(false);
  });

  it("offers every way, each needing an address, when the check found no route", () => {
    const none = route({ localToRemote: failed, remoteToLocal: failed });
    expect(none).toMatchObject({
      choice: null,
      ready: false,
      problem: true,
      line: "Neither server could reach the other. Use Change to enter an address.",
    });
    expect(none.options.map((option) => option.asks)).toEqual([
      ["remoteOrigin", "localOrigin"],
      ["remoteOrigin"],
      ["localOrigin"],
    ]);
  });
});

/** Records each call in order; `fail` names the calls that throw, `records` what each server holds. */
const recordingOps = (
  input: {
    readonly fail?: ReadonlyArray<string>;
    readonly records?: Record<string, PeerRecord | null>;
    readonly introduced?: boolean;
    /** What forgetting a link says of the session it left on the other server. */
    readonly sessionLeft?: string;
  } = {},
) => {
  const calls: Array<string> = [];
  const links: Array<PeerLinkCreateInput & { readonly holder: string }> = [];
  const run = (call: string) => {
    calls.push(call);
    if (input.fail?.includes(call)) throw new Error(`${call} failed`);
  };
  const ops: PairLinkOps = {
    enableLinkedEnvironments: async (id) => run(`enable ${id}`),
    mintPairingCode: async (id, access) => {
      run(`mint ${id} ${access}`);
      return "code";
    },
    link: async (holder, link) => {
      run(`link ${holder}`);
      links.push({ holder, ...link });
    },
    forget: async (holder, other) => {
      run(`forget ${other} on ${holder}`);
      return { detail: input.sessionLeft ?? null };
    },
    removePeer: async (holder, other) => run(`remove ${other} on ${holder}`),
    introduce: async (choice) => {
      run(`introduce ${choice.connections}`);
      return input.introduced === false
        ? { ok: false, steps: [{ title: "Issue a credential", status: "failed", detail: "no" }] }
        : { ok: true, steps: [] };
    },
    peerRecord: async (holder, other) => {
      run(`record ${holder}`);
      return input.records?.[holder] ?? record(other, other);
    },
  };
  return { calls, links, ops };
};

const direct: PeeringChoice = {
  connections: "both",
  localOrigin: "https://laptop.example",
  remoteOrigin: "https://work.example",
};
const plan = (fields: Partial<PairLinkPlan> = {}): PairLinkPlan => ({
  local: laptop,
  remote: work,
  messaging: { kind: "set-up", choice: direct, clearLeftover: null },
  localLevel: "approval-required",
  remoteLevel: "approval-required",
  turnOn: [],
  ...fields,
});

describe("linkPair", () => {
  it("sets up messaging, then links each direction at the address its messages take", async () => {
    const { calls, links, ops } = recordingOps({
      records: {
        // Work stores for Laptop, so it reaches Laptop through Laptop's line.
        [WORK]: record(LAPTOP, "Laptop", {
          linkMode: "store",
          origin: null,
          lineAddress: "http://127.77.0.1:1",
        }),
        [LAPTOP]: record(WORK, "Work", { linkMode: "poll" }),
      },
    });
    const result = await linkPair(
      plan({
        messaging: {
          kind: "set-up",
          choice: { ...direct, connections: "local-only" },
          clearLeftover: "remote",
        },
        turnOn: [work],
      }),
      ops,
    );
    expect(calls).toEqual([
      // The old pair's links go before its record, while each can still revoke its own session.
      `forget ${WORK} on ${LAPTOP}`,
      `forget ${LAPTOP} on ${WORK}`,
      `remove ${LAPTOP} on ${WORK}`,
      "introduce local-only",
      `enable ${WORK}`,
      `record ${LAPTOP}`,
      `mint ${WORK} approval-required`,
      `link ${LAPTOP}`,
      `record ${WORK}`,
      `mint ${LAPTOP} approval-required`,
      `link ${WORK}`,
    ]);
    expect(links.map((made) => [made.holder, made.url, made.expectedEnvironmentId])).toEqual([
      [LAPTOP, "https://work.example", WORK],
      [WORK, "http://127.77.0.1:1", LAPTOP],
    ]);
    expect(result).toMatchObject({ messaging: "set-up" });
    expect(pairResultOf(result)).toEqual({
      headline: "Linked for messages and tools both ways.",
      problems: [],
    });
  });

  it("links nothing when messaging could not be set up", async () => {
    const { calls, ops } = recordingOps({ introduced: false });
    const result = await linkPair(plan(), ops);
    expect(calls).toEqual(["introduce both"]);
    expect(result).toMatchObject({ messaging: "failed", directions: [] });
    expect(result.steps).toHaveLength(1);
  });

  it("stops before issuing anything when the other server's old record cannot be cleared", async () => {
    const { calls, ops } = recordingOps({
      fail: [`remove ${LAPTOP} on ${WORK}`],
      sessionLeft: "The session stays there.",
    });
    const result = await linkPair(
      plan({ messaging: { kind: "set-up", choice: direct, clearLeftover: "remote" } }),
      ops,
    );
    expect(calls).toEqual([
      `forget ${WORK} on ${LAPTOP}`,
      `forget ${LAPTOP} on ${WORK}`,
      `remove ${LAPTOP} on ${WORK}`,
    ]);
    expect(result.messaging).toBe("failed");
    // A link already forgotten left its session behind; the failed step after it must not hide that.
    expect(result.steps.map((step) => [step.status, step.detail])).toEqual([
      ["done", "The session stays there."],
      ["done", "The session stays there."],
      ["failed", `remove ${LAPTOP} on ${WORK} failed`],
    ]);
  });

  it("leaves a direction Off when its tools fail, and keeps the rest", async () => {
    const { calls, ops } = recordingOps({ fail: [`link ${LAPTOP}`] });
    const result = await linkPair(plan({ remoteLevel: "off" }), ops);
    expect(calls).not.toContain(`link ${WORK}`);
    expect(result.directions).toMatchObject([{ holder: laptop, error: `link ${LAPTOP} failed` }]);
    expect(pairResultOf(result).headline).toBe("Linked for messages.");
    expect(pairResultOf(result).problems).toHaveLength(1);
    // A direction that already had tools counts in what the pair now has.
    expect(pairResultOf({ ...result, kept: 1 }).headline).toBe(
      "Linked for messages and tools one way.",
    );
  });

  it("says a poller has not connected yet when its line address is not there", async () => {
    const { calls, ops } = recordingOps({
      records: {
        [WORK]: record(LAPTOP, "Laptop", { linkMode: "store", origin: null, lineAddress: null }),
      },
    });
    const result = await linkPair(plan({ localLevel: "off" }), ops);
    expect(calls).toEqual(["introduce both", `record ${WORK}`]);
    expect(result.directions[0]?.error).toBe(
      "Laptop has not connected to Work yet, so Work can't reach it.",
    );
  });

  it("links a server that does not run J5 at the addresses this client knows, with no messaging", async () => {
    const { calls, links, ops } = recordingOps();
    const result = await linkPair(
      plan({
        messaging: {
          kind: "none",
          localUrls: ["https://laptop.ts.net"],
          remoteUrls: ["https://work.ts.net", "https://work.lan"],
        },
      }),
      ops,
    );
    expect(
      calls.filter((call) => call.startsWith("introduce") || call.startsWith("record")),
    ).toEqual([]);
    expect(links.map((made) => [made.holder, made.url, made.alternateUrls])).toEqual([
      [LAPTOP, "https://work.ts.net", ["https://work.lan"]],
      [WORK, "https://laptop.ts.net", undefined],
    ]);
    expect(pairResultOf(result).headline).toBe("Linked for tools both ways.");
  });

  it("makes no link when Linked environments could not be turned on", async () => {
    const { calls, ops } = recordingOps({ fail: [`enable ${WORK}`] });
    const result = await linkPair(plan({ turnOn: [work] }), ops);
    expect(calls).toEqual(["introduce both", `enable ${WORK}`]);
    expect(result.directions.every((direction) => direction.error !== null)).toBe(true);
  });
});

describe("prepareRequestLink", () => {
  it("sets up messaging and hands back where the agent's link is made", async () => {
    const { calls, ops } = recordingOps();
    expect(await prepareRequestLink(plan({ remoteLevel: "off", turnOn: [work] }), ops)).toEqual({
      ok: true,
      urls: ["https://environment-work.example"],
    });
    expect(calls).toEqual(["introduce both", `enable ${WORK}`, `record ${LAPTOP}`]);
  });

  it("stops before the answer when messaging fails, so the card stays open", async () => {
    const { ops } = recordingOps({ introduced: false });
    expect(await prepareRequestLink(plan(), ops)).toMatchObject({ ok: false, error: null });
  });
});

describe("requestLinkStateOf", () => {
  const at = (iso: string) => DateTime.makeUnsafe(iso).epochMilliseconds;
  it("makes a link, renews one that ran out, and uses a live one as it is", () => {
    const live = link(WORK, "Work");
    expect(requestLinkStateOf(null, at("2026-11-10T00:00:00.000Z"))).toBe("new");
    expect(requestLinkStateOf(live, at("2026-11-10T00:00:00.000Z"))).toBe("existing");
    expect(requestLinkStateOf(live, at("2026-12-02T00:00:00.000Z"))).toBe("renew");
    expect(requestLinkStateOf({ ...live, status: "expired" }, at("2026-11-10T00:00:00.000Z"))).toBe(
      "renew",
    );
  });
});
