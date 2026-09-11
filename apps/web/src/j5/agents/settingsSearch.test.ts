import { describe, expect, it } from "vite-plus/test";

import { searchSettings } from "../../components/settings/settingsSearch";

describe("agent library settings search", () => {
  it("exposes the Agents destination", () => {
    expect(searchSettings("agents")[0]).toMatchObject({
      id: "agents",
      to: "/settings/agents",
    });
  });
});
