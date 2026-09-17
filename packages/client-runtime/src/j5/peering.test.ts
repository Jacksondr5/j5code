import { describe, expect, it } from "vite-plus/test";

import {
  defaultPeerOrigin,
  introducePeers,
  peerOriginWarning,
  resolvePeeringReadiness,
  type PeeringSide,
} from "./peering.ts";

const work: PeeringSide = {
  environmentId: "environment-work",
  label: "Work",
  origin: "https://work.example:3773",
};
const home: PeeringSide = {
  environmentId: "environment-home",
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
