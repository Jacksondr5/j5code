import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  defaultPeerOrigin,
  introducePeers,
  introducePollingPeer,
  peerOriginWarning,
  peeringCandidates,
  peeringChoiceReady,
  peeringLines,
  peeringReachFrom,
  peeringRunMode,
  recommendPeering,
  resolvePeeringReadiness,
  type PeeringReach,
  type PeeringServer,
  type PeeringSide,
} from "./peering.ts";

const work: PeeringSide = {
  environmentId: EnvironmentId.make("environment-work"),
  label: "Work",
  origin: "https://work.example:3773",
};
const home: PeeringSide = {
  environmentId: EnvironmentId.make("environment-home"),
  label: "Home",
  origin: "https://home.example:3773",
};

describe("defaultPeerOrigin", () => {
  it("offers the client's own base URL as a hint with the trailing slash removed", () => {
    expect(defaultPeerOrigin("https://home.example:3773/")).toBe("https://home.example:3773");
    expect(defaultPeerOrigin(null)).toBe("");
  });
});

describe("peerOriginWarning", () => {
  it("warns only for loopback addresses another server cannot reach", () => {
    expect(peerOriginWarning("http://127.0.0.1:3773")).toContain("loopback");
    expect(peerOriginWarning("http://localhost:3773")).toContain("loopback");
    expect(peerOriginWarning("https://home.example:3773")).toBeNull();
    expect(peerOriginWarning("")).toBeNull();
    expect(peerOriginWarning("not a url")).toBeNull();
  });
});

describe("resolvePeeringReadiness", () => {
  const ready = {
    otherLabel: "Home",
    otherConnected: true,
    otherCanManage: true,
    localOrigin: work.origin,
    remoteOrigin: home.origin,
  };
  it("requires a chosen, connected, manageable environment and two valid origins", () => {
    expect(resolvePeeringReadiness({ ...ready, otherLabel: null })).toMatchObject({
      kind: "missing-environment",
    });
    expect(resolvePeeringReadiness({ ...ready, otherConnected: false })).toMatchObject({
      kind: "environment-disconnected",
    });
    expect(resolvePeeringReadiness({ ...ready, otherCanManage: false })).toMatchObject({
      kind: "read-only-environment",
    });
    expect(
      resolvePeeringReadiness({ ...ready, remoteOrigin: "https://home.example/with/path" }),
    ).toMatchObject({ kind: "invalid-origin" });
    expect(resolvePeeringReadiness(ready)).toEqual({ kind: "ready" });
  });
});

describe("introducePeers", () => {
  it("issues on both sides, then records each on the other with the credential the other issued", async () => {
    const calls: Array<string> = [];
    const outcome = await introducePeers({
      local: work,
      remote: home,
      issue: async (issuer, holder) => {
        calls.push(`issue ${issuer.label} for ${holder.label}`);
        return { credential: `${issuer.label}-issued-for-${holder.label}` };
      },
      record: async (recorder, peer, credential) => {
        calls.push(
          `record ${peer.label} on ${recorder.label} at ${peer.origin} with ${credential}`,
        );
      },
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.steps.map((step) => step.status)).toEqual(["done", "done", "done", "done"]);
    expect(calls).toEqual([
      "issue Work for Home",
      "issue Home for Work",
      "record Home on Work at https://home.example:3773 with Home-issued-for-Work",
      "record Work on Home at https://work.example:3773 with Work-issued-for-Home",
    ]);
  });

  it("stops at the first failure and reports the rest as skipped", async () => {
    const calls: Array<string> = [];
    const outcome = await introducePeers({
      local: work,
      remote: home,
      issue: async (issuer, holder) => {
        calls.push(`issue ${issuer.label} for ${holder.label}`);
        return { credential: "c" };
      },
      record: async (recorder, peer) => {
        calls.push(`record ${peer.label} on ${recorder.label}`);
        throw new Error(`Could not reach a J5 server at ${peer.origin}`);
      },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.steps).toEqual([
      { step: "issue-local", status: "done", detail: null },
      { step: "issue-remote", status: "done", detail: null },
      {
        step: "record-remote",
        status: "failed",
        detail: "Could not reach a J5 server at https://home.example:3773",
      },
      { step: "record-local", status: "skipped", detail: null },
    ]);
    expect(calls).toHaveLength(3);
  });
});

const laptop: PeeringServer = {
  environmentId: EnvironmentId.make("environment-laptop"),
  label: "JM-LT-04213",
  serverVersion: "0.0.48",
  supportsPoll: true,
  runMode: "desktop",
};
const vm: PeeringServer = {
  environmentId: EnvironmentId.make("environment-vm"),
  label: "Work VM",
  serverVersion: "0.0.48",
  supportsPoll: true,
  runMode: "service",
};
const vmOrigin = "https://work-vm.corp.example:3773";
const laptopOrigin = "http://10.20.4.17:3773";
const reached = (origin: string): PeeringReach => ({ kind: "reached", origin });
const failed: PeeringReach = {
  kind: "failed",
  errors: ["10.20.4.17:3773: connection timed out after 4s"],
};

describe("peeringRunMode", () => {
  it("reads how a server is run from its self-update capability", () => {
    expect(peeringRunMode("boot-service")).toBe("service");
    expect(peeringRunMode("desktop-managed")).toBe("desktop");
    expect(peeringRunMode("respawn")).toBe("by-hand");
    expect(peeringRunMode(undefined)).toBe("by-hand");
  });
});

describe("peeringCandidates and peeringReachFrom", () => {
  it("tries the client's own address first, never loopback, each once", () => {
    expect(
      peeringCandidates({
        clientUrl: `${vmOrigin}/`,
        addresses: ["http://10.0.0.5:3773", vmOrigin, "http://127.0.0.1:3773"],
      }),
    ).toEqual([vmOrigin, "http://10.0.0.5:3773"]);
    expect(peeringCandidates({ clientUrl: "http://localhost:3773", addresses: [] })).toEqual([]);
  });

  it("counts a probe only when the expected server answers, and keeps each error verbatim", () => {
    const candidates = ["http://127.0.0.2:3773", laptopOrigin];
    expect(peeringReachFrom({ expected: laptop, candidates: [], probes: [] })).toEqual({
      kind: "untested",
      error: null,
    });
    expect(
      peeringReachFrom({
        expected: laptop,
        candidates,
        probes: [
          {
            outcome: "reached",
            origin: "http://127.0.0.2:3773",
            environmentId: "environment-vm",
            label: "Work VM",
          },
          {
            outcome: "failed",
            origin: laptopOrigin,
            error: "10.20.4.17:3773: connection timed out after 4s",
          },
        ],
      }),
    ).toEqual({
      kind: "failed",
      errors: [
        "127.0.0.2:3773: Work VM answered, not JM-LT-04213",
        "10.20.4.17:3773: connection timed out after 4s",
      ],
    });
    expect(
      peeringReachFrom({
        expected: laptop,
        candidates,
        probes: [
          {
            outcome: "reached",
            origin: laptopOrigin,
            environmentId: "environment-laptop",
            label: "JM-LT-04213",
          },
        ],
      }),
    ).toEqual(reached(laptopOrigin));
  });

  it("keeps the error when a server could not list its own addresses", () => {
    expect(
      peeringReachFrom({
        expected: laptop,
        candidates: [],
        probes: [],
        addressesError: "access expired",
      }),
    ).toEqual({ kind: "untested", error: "access expired" });
    expect(
      peeringReachFrom({
        expected: laptop,
        candidates: [laptopOrigin],
        probes: [
          {
            outcome: "failed",
            origin: laptopOrigin,
            error: "10.20.4.17:3773: connection refused",
          },
        ],
        addressesError: "access expired",
      }),
    ).toEqual({
      kind: "failed",
      errors: [
        "JM-LT-04213 could not list its addresses: access expired",
        "10.20.4.17:3773: connection refused",
      ],
    });
  });
});

describe("recommendPeering", () => {
  it("polls without asking when one direction cannot connect", () => {
    const recommendation = recommendPeering({
      local: laptop,
      remote: vm,
      localToRemote: reached(vmOrigin),
      remoteToLocal: failed,
    });
    expect(recommendation).toEqual({
      kind: "setup",
      choice: { connections: "local-only", localOrigin: "", remoteOrigin: vmOrigin },
      question: null,
    });
    if (recommendation.kind !== "setup") throw new Error("unreachable");
    expect(peeringLines(recommendation.choice, laptop, vm)).toEqual([
      "JM-LT-04213 sends A2A messages to Work VM directly.",
      "Work VM stores A2A messages for JM-LT-04213 and waits for JM-LT-04213 to poll for them.",
    ]);
  });

  it("sends directly both ways without asking when both connect and both run as services", () => {
    const home = { ...laptop, label: "Home Server", runMode: "service" as const };
    const recommendation = recommendPeering({
      local: home,
      remote: vm,
      localToRemote: reached(vmOrigin),
      remoteToLocal: reached("https://home.tail1234.ts.net:3773"),
    });
    expect(recommendation.kind === "setup" && recommendation.question).toBeNull();
    if (recommendation.kind !== "setup") throw new Error("unreachable");
    expect(peeringLines(recommendation.choice, home, vm)).toEqual([
      `Home Server sends A2A messages to Work VM directly, at ${vmOrigin}.`,
      "Work VM sends A2A messages to Home Server directly, at https://home.tail1234.ts.net:3773.",
    ]);
  });

  it("asks how to reach a side the desktop app runs or that was started by hand, storing by default", () => {
    for (const runMode of ["desktop", "by-hand"] as const) {
      const homeMac = { ...laptop, label: "Home Mac", runMode };
      const recommendation = recommendPeering({
        local: homeMac,
        remote: vm,
        localToRemote: reached(vmOrigin),
        remoteToLocal: reached("https://home-mac.tail1234.ts.net:3773"),
      });
      if (recommendation.kind !== "setup") throw new Error("unreachable");
      expect(recommendation.question?.toward).toBe("local");
      expect(recommendation.question?.reason).toBe(runMode);
      expect(recommendation.choice.connections).toBe("local-only");
      expect(recommendation.question?.directChoice.connections).toBe("both");
      expect(recommendation.question?.directNeedsAddress).toBe(false);
    }
  });

  it("asks about a direction it could not test, with polling the default and an address to send directly", () => {
    const recommendation = recommendPeering({
      local: laptop,
      remote: vm,
      localToRemote: reached(vmOrigin),
      remoteToLocal: { kind: "untested", error: null },
    });
    if (recommendation.kind !== "setup") throw new Error("unreachable");
    expect(recommendation.question).toMatchObject({
      toward: "local",
      reason: "untested",
      directNeedsAddress: true,
    });
    expect(recommendation.choice.connections).toBe("local-only");
    expect(peeringChoiceReady(recommendation.choice)).toBe(true);
    expect(peeringChoiceReady(recommendation.question!.directChoice)).toBe(false);
  });

  it("offers nothing when either server is too old, or when neither can reach the other", () => {
    const old = { ...vm, supportsPoll: false, serverVersion: "0.0.44" };
    expect(
      recommendPeering({
        local: laptop,
        remote: old,
        localToRemote: reached(vmOrigin),
        remoteToLocal: failed,
      }),
    ).toEqual({ kind: "too-old", server: old });
    expect(
      recommendPeering({ local: laptop, remote: vm, localToRemote: failed, remoteToLocal: failed }),
    ).toEqual({ kind: "no-route" });
  });
});

describe("introducePollingPeer", () => {
  it("issues a store credential on the reachable server, then records it on the poller", async () => {
    const calls: Array<string> = [];
    const outcome = await introducePollingPeer({
      poller: { environmentId: laptop.environmentId, label: laptop.label, origin: "" },
      storer: { environmentId: vm.environmentId, label: vm.label, origin: vmOrigin },
      issue: async (storer, poller) => {
        calls.push(`issue on ${storer.label} for ${poller.label}`);
        return { credential: "vm-issued" };
      },
      record: async (poller, storer, credential) => {
        calls.push(
          `record ${storer.label} at ${storer.origin} on ${poller.label} with ${credential}`,
        );
      },
    });
    expect(outcome.ok).toBe(true);
    expect(calls).toEqual([
      "issue on Work VM for JM-LT-04213",
      `record Work VM at ${vmOrigin} on JM-LT-04213 with vm-issued`,
    ]);

    const refused = await introducePollingPeer({
      poller: { environmentId: laptop.environmentId, label: laptop.label, origin: "" },
      storer: { environmentId: vm.environmentId, label: vm.label, origin: vmOrigin },
      issue: async () => {
        throw new Error("Work VM does not store messages for a peer that polls");
      },
      record: async () => undefined,
    });
    expect(refused.steps).toEqual([
      {
        step: "issue-store",
        status: "failed",
        detail: "Work VM does not store messages for a peer that polls",
      },
      { step: "record-poll", status: "skipped", detail: null },
    ]);
  });
});
