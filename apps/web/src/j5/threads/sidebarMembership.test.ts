import { describe, expect, it } from "vite-plus/test";

import { isSidebarMember } from "./sidebarMembership";

describe("sidebar membership (D22)", () => {
  const spawned = { createdBy: "agent", creationSource: "mcp", forkedFrom: null } as const;

  it("moves an agent-spawned thread out of the top level unless it is pinned", () => {
    expect(isSidebarMember({ ...spawned, pinnedAt: null })).toBe(false);
    expect(isSidebarMember({ ...spawned, pinnedAt: "2026-09-09T00:00:00Z" })).toBe(true);
  });

  it("keeps every thread a person or the system created", () => {
    expect(isSidebarMember({ createdBy: "user", creationSource: "web", pinnedAt: null })).toBe(
      true,
    );
    expect(isSidebarMember({ createdBy: "user", creationSource: "mcp", pinnedAt: null })).toBe(
      true,
    );
    expect(isSidebarMember({ createdBy: "system", creationSource: "server", pinnedAt: null })).toBe(
      true,
    );
  });

  it("keeps an agent's thread that did not come through the MCP tools", () => {
    expect(
      isSidebarMember({ createdBy: "agent", creationSource: "provider", pinnedAt: null }),
    ).toBe(true);
  });

  it("keeps a thread an agent forked, which is placed beside its source and not under the agent", () => {
    expect(
      isSidebarMember({ ...spawned, forkedFrom: { threadId: "thread:source" }, pinnedAt: null }),
    ).toBe(true);
  });
});
