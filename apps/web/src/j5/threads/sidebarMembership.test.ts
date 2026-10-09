import { describe, expect, it } from "vite-plus/test";

import { isSidebarMember } from "./sidebarMembership";

describe("sidebar membership", () => {
  it("moves an agent-spawned thread under its spawner unless it is pinned", () => {
    expect(isSidebarMember({ pinnedAt: null }, true)).toBe(false);
    expect(isSidebarMember({ pinnedAt: "2026-09-09T00:00:00Z" }, true)).toBe(true);
  });

  it("keeps every thread an agent did not spawn, including rows the read has not answered for", () => {
    expect(isSidebarMember({ pinnedAt: null }, false)).toBe(true);
    expect(isSidebarMember({}, false)).toBe(true);
  });
});
