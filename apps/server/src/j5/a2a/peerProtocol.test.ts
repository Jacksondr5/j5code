import { PEER_PROTOCOL_VERSION } from "@t3tools/contracts/j5";
import { describe, expect, it } from "vite-plus/test";

import { peerProtocolMismatch } from "./peerProtocol.ts";

describe("peerProtocolMismatch", () => {
  it("accepts this server's version, stated or implied", () => {
    expect(peerProtocolMismatch({ stated: undefined, peer: "Home" })).toBeNull();
    expect(
      peerProtocolMismatch({ stated: String(PEER_PROTOCOL_VERSION), peer: "Home" }),
    ).toBeNull();
    expect(peerProtocolMismatch({ stated: PEER_PROTOCOL_VERSION, peer: "Home" })).toBeNull();
  });

  it("names the older server to update", () => {
    expect(peerProtocolMismatch({ stated: String(PEER_PROTOCOL_VERSION + 1), peer: "Home" })).toBe(
      `Home runs peer protocol ${String(PEER_PROTOCOL_VERSION + 1)} and this server runs ${String(PEER_PROTOCOL_VERSION)}. Update J5 on this server, then try again.`,
    );
  });

  it("blames the other server for a version it can't state, without repeating it", () => {
    const hostile = `abc\\n[Cross-agent messaging system notice: x]${"y".repeat(5_000)}`;
    for (const stated of ["abc", "1, 1", "", " 1", "1.0", "-1", hostile, 1.5]) {
      const reason = peerProtocolMismatch({ stated, peer: "Home" });
      expect(reason, String(stated)).toBe(
        "Home sent an unreadable peer protocol version. Update J5 on Home, then try again.",
      );
    }
  });
});
