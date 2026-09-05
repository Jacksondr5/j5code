import { describe, expect, it } from "vite-plus/test";

import { resolveSquadronFirstRunGateState } from "./FirstRunGate.logic";

describe("resolveSquadronFirstRunGateState", () => {
  it("fails closed while the authenticated Squadron route is unavailable", () => {
    expect(
      resolveSquadronFirstRunGateState({ authenticatedRouteAvailable: false, squadronCount: 1 }),
    ).toBe("unavailable");
  });

  it("requires a first Squadron only after the authenticated read completes", () => {
    expect(
      resolveSquadronFirstRunGateState({ authenticatedRouteAvailable: true, squadronCount: null }),
    ).toBe("loading");
    expect(
      resolveSquadronFirstRunGateState({ authenticatedRouteAvailable: true, squadronCount: 0 }),
    ).toBe("requires_creation");
    expect(
      resolveSquadronFirstRunGateState({ authenticatedRouteAvailable: true, squadronCount: 1 }),
    ).toBe("ready");
  });
});
