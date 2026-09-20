import { describe, expect, it } from "vite-plus/test";

import {
  catalogScopeFor,
  extractPartialApplyResult,
  initialSelection,
  isCatalogActionable,
  isCatalogScopeChanged,
  isSourceChangedError,
  isSourceSaveable,
  loadedSourceAfterStatus,
  pruneSelectedGroups,
  summarizeApplyResult,
} from "./skillCatalogView";

describe("skill catalog view helpers", () => {
  it("gates source saves on blank or unchanged drafts", () => {
    expect(isSourceSaveable("", "/opt/skills")).toBe(false);
    expect(isSourceSaveable("   ", "/opt/skills")).toBe(false);
    expect(isSourceSaveable("/opt/skills", "/opt/skills")).toBe(false);
    expect(isSourceSaveable("  /opt/skills  ", "/opt/skills")).toBe(false);
    expect(isSourceSaveable("https://example.com/skills.git", "/opt/skills")).toBe(true);
  });

  it("summarizes apply counts", () => {
    expect(summarizeApplyResult({ installed: 3, removed: 1, unchanged: 5 })).toBe(
      "Installed 3 links, removed 1, 5 unchanged.",
    );
  });

  it("extracts partial results only from skill catalog errors", () => {
    const result = {
      selectedGroups: ["core"],
      installed: 1,
      removed: 0,
      unchanged: 0,
      conflicts: [],
      failed: [{ linkPath: "/tmp/x", error: "boom" }],
    };
    expect(extractPartialApplyResult({ _tag: "SkillCatalogError", message: "x", result })).toEqual(
      result,
    );
    expect(extractPartialApplyResult({ _tag: "SkillCatalogError", message: "x" })).toBeUndefined();
    expect(extractPartialApplyResult({ _tag: "OtherError", result })).toBeUndefined();
    expect(extractPartialApplyResult(new Error("boom"))).toBeUndefined();
    expect(extractPartialApplyResult(null)).toBeUndefined();
    expect(
      extractPartialApplyResult({ _tag: "SkillCatalogError", result: { installed: 1 } }),
    ).toBeUndefined();
  });

  it("preselects only saved groups the catalog still knows", () => {
    expect(initialSelection(null)).toEqual([]);
    expect(
      initialSelection({
        groups: [{ name: "core" }, { name: "extras" }],
        selectedGroups: ["core", "retired"],
      }),
    ).toEqual(["core"]);
  });

  it("prunes selections against the latest known groups", () => {
    // An Update removed "extra" while ["core", "extra"] was checked.
    expect(pruneSelectedGroups(["core", "extra"], [{ name: "core" }])).toEqual(["core"]);
    expect(pruneSelectedGroups([], [{ name: "core" }])).toEqual([]);
    expect(pruneSelectedGroups(["core"], [])).toEqual([]);
  });

  it("detects stale-page source errors", () => {
    expect(isSourceChangedError("Skill catalog source changed. Reload and retry.")).toBe(true);
    expect(isSourceChangedError("boom")).toBe(false);
    expect(isSourceChangedError(null)).toBe(false);
  });

  it("derives catalog identity from acknowledged settings", () => {
    // Identity follows live settings: another client's A → B change moves the
    // scope, so requests submit B instead of a cached A.
    expect(catalogScopeFor("env-1", "/catalog/A")).toBe("env-1::/catalog/A");
    expect(catalogScopeFor("env-1", "/catalog/B")).toBe("env-1::/catalog/B");
    expect(isCatalogScopeChanged("env-1::/catalog/A", "env-1::/catalog/B")).toBe(true);
    expect(isCatalogScopeChanged("env-1::/catalog/B", "env-1::/catalog/B")).toBe(false);
    // Loaded status adopts the queried source only on success.
    expect(loadedSourceAfterStatus("/catalog/A", "/catalog/A", true)).toBe("/catalog/A");
    expect(loadedSourceAfterStatus(null, "/catalog/B", true)).toBe("/catalog/B");
    expect(loadedSourceAfterStatus("/catalog/A", "/catalog/B", false)).toBe("/catalog/A");
    expect(loadedSourceAfterStatus(null, "/catalog/B", false)).toBe(null);
  });

  it("enables actions only for the displayed source with matching loaded status", () => {
    const ready = {
      busy: false,
      isPending: false,
      hasData: true,
      displayedSource: "/catalog/B",
      configuredSource: "/catalog/B",
      loadedSource: "/catalog/B",
    };
    expect(isCatalogActionable(ready)).toBe(true);
    // Saving B failed: the input still shows B against configured A.
    expect(isCatalogActionable({ ...ready, configuredSource: "/catalog/A" })).toBe(false);
    // Another client changed A → B: B's status has not loaded yet.
    expect(isCatalogActionable({ ...ready, loadedSource: "/catalog/A", hasData: false })).toBe(
      false,
    );
    expect(isCatalogActionable({ ...ready, loadedSource: "/catalog/A" })).toBe(false);
    // Unsaved draft edits and in-flight states stay disabled.
    expect(isCatalogActionable({ ...ready, displayedSource: "  /catalog/B (edited)" })).toBe(false);
    expect(isCatalogActionable({ ...ready, busy: true })).toBe(false);
    expect(isCatalogActionable({ ...ready, isPending: true })).toBe(false);
    expect(isCatalogActionable({ ...ready, hasData: false })).toBe(false);
    expect(isCatalogActionable({ ...ready, loadedSource: null })).toBe(false);
  });
});
