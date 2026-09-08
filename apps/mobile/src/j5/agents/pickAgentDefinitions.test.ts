import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { isForegroundHandoffActive } from "../../lib/foreground-handoff";
import { pickAgentDefinitions } from "./pickAgentDefinitions";

const pickers = vi.hoisted(() => {
  class File {
    static pickFileAsync = vi.fn();
    readonly size = 2;
    constructor(readonly name: string) {}
    async text() {
      return "{}";
    }
  }
  class Directory {
    static pickDirectoryAsync = vi.fn();
    constructor(
      readonly name: string,
      readonly uri: string,
      readonly children: Array<File | Directory>,
    ) {}
    list() {
      return this.children;
    }
  }
  return { File, Directory };
});
vi.mock("expo-file-system", () => pickers);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("native agent definition selection", () => {
  it("collects nested agent.json files under the selected directory", async () => {
    pickers.Directory.pickDirectoryAsync.mockImplementation(async () => {
      expect(isForegroundHandoffActive()).toBe(true);
      return new pickers.Directory("team", "root", [
        new pickers.File("README.md"),
        new pickers.Directory("scout", "root/scout", [new pickers.File("agent.json")]),
        new pickers.Directory("builder", "root/builder", [new pickers.File("agent.json")]),
      ]);
    });
    const files = await pickAgentDefinitions("folder");
    expect(files?.map(({ name }) => name).sort()).toEqual([
      "team/builder/agent.json",
      "team/scout/agent.json",
    ]);
    expect(isForegroundHandoffActive()).toBe(false);
    expect(pickers.File.pickFileAsync).not.toHaveBeenCalled();
  });

  it("reads only the single chosen file", async () => {
    pickers.File.pickFileAsync.mockResolvedValue({
      canceled: false,
      result: new pickers.File("agent.json"),
    });
    expect(await pickAgentDefinitions("agent")).toEqual([{ name: "agent.json", content: "{}" }]);
    expect(pickers.Directory.pickDirectoryAsync).not.toHaveBeenCalled();
    expect(isForegroundHandoffActive()).toBe(false);
  });

  it("treats native picker cancellation as no selection and ends the handoff", async () => {
    for (const code of ["ERR_FILE_PICKING_CANCELLED", "ERR_PICKER_CANCELLED"]) {
      pickers.Directory.pickDirectoryAsync.mockRejectedValue(
        Object.assign(new Error("Cancelled"), { code }),
      );
      expect(await pickAgentDefinitions("folder")).toBeNull();
      expect(isForegroundHandoffActive()).toBe(false);
    }
    pickers.File.pickFileAsync.mockResolvedValue({ canceled: true, result: null });
    expect(await pickAgentDefinitions("agent")).toBeNull();
    expect(isForegroundHandoffActive()).toBe(false);
  });

  it("reports access failures instead of importing a partial selection", async () => {
    pickers.Directory.pickDirectoryAsync.mockRejectedValue(new Error("Access denied"));
    await expect(pickAgentDefinitions("folder")).rejects.toThrow("Access denied");
    expect(isForegroundHandoffActive()).toBe(false);
  });
});
