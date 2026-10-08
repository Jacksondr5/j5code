import { describe, expect, it } from "vite-plus/test";

import { isSidebarMember } from "./sidebarMembership";

describe("SB5 sidebar membership", () => {
  const known = (origin?: "human" | "agent") => ({
    kind: "known" as const,
    ...(origin === undefined ? {} : { origin }),
  });
  it("hides agent-spawned peers unless pinned and keeps human, unknown, and silent homes", () => {
    expect(isSidebarMember({ pinnedAt: null }, known("agent"))).toBe(false);
    expect(isSidebarMember({ pinnedAt: "2026-09-09T00:00:00Z" }, known("agent"))).toBe(true);
    expect(isSidebarMember({ pinnedAt: null }, known("human"))).toBe(true);
    expect(isSidebarMember({ pinnedAt: null }, known())).toBe(true);
    expect(isSidebarMember({ pinnedAt: null }, { kind: "unknown" })).toBe(true);
    expect(isSidebarMember({ pinnedAt: null }, undefined)).toBe(true);
  });
});
