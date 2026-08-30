import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import {
  returnCommandPaletteProjectSelection,
  type CommandPaletteProjectSelection,
} from "./commandPaletteBus";

const selection: CommandPaletteProjectSelection = {
  projectRef: {
    environmentId: EnvironmentId.make("environment-primary"),
    projectId: ProjectId.make("project-folder"),
  },
  title: "J5 Code",
  workspaceRoot: "/work/j5code",
};

describe("returnCommandPaletteProjectSelection", () => {
  it("keeps ordinary Add Project callers on their existing navigation path when no callback opts in", () => {
    expect(returnCommandPaletteProjectSelection(undefined, selection)).toBe(false);
  });

  it("returns the explicit durable project only to an opt-in picker caller", () => {
    const onProjectSelected = vi.fn();

    expect(returnCommandPaletteProjectSelection(onProjectSelected, selection)).toBe(true);
    expect(onProjectSelected).toHaveBeenCalledOnce();
    expect(onProjectSelected).toHaveBeenCalledWith(selection);
  });
});
