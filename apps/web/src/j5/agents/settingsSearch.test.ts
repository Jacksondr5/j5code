import { describe, expect, it } from "vite-plus/test";

import { searchSettings } from "../../components/settings/settingsSearch";

describe("persona library settings search", () => {
  it("exposes the Personas destination, under its old name too", () => {
    expect(searchSettings("personas")[0]).toMatchObject({
      id: "personas",
      to: "/settings/personas",
    });
    expect(searchSettings("agents").some((entry) => entry.id === "personas")).toBe(true);
  });
});
