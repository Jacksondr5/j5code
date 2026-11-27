import { describe, expect, it } from "vite-plus/test";

import { createFormExit } from "./formExit";

describe("createFormExit", () => {
  it("leaves with the Back that waited once the save lands", () => {
    const exit = createFormExit<string>();
    expect(exit.onBack("back", true)).toBe("wait");
    expect(exit.saveLanded()).toBe("back");
    expect(exit.onBack("back again", false)).toBe("leave");
  });

  it("stays after a failed save, and the next Back asks instead of reusing the old one", () => {
    const exit = createFormExit<string>();
    expect(exit.onBack("back", true)).toBe("wait");
    exit.saveFailed();
    expect(exit.onBack("back again", false)).toBe("ask");
    expect(exit.saveLanded()).toBeNull();
  });
});
