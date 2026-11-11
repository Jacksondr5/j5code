import { describe, expect, it } from "vite-plus/test";

import { personaRowMarker, personaSheetActions } from "./personaSheet";

describe("personaSheetActions", () => {
  it("offers only Restore for a removed persona, even an editable one", () => {
    expect(personaSheetActions({ removed: true, editable: true }, true)).toEqual(["restore"]);
  });

  it("offers Edit only for an editable persona, and Copy only with another environment", () => {
    expect(personaSheetActions({ removed: false, editable: true }, true)).toEqual([
      "edit",
      "duplicate",
      "export",
      "copy",
      "remove",
    ]);
    expect(personaSheetActions({ removed: false, editable: false }, false)).toEqual([
      "duplicate",
      "export",
      "remove",
    ]);
  });
});

describe("personaRowMarker", () => {
  it("names one state, removed first, then blocked, then an override", () => {
    const all = { removed: true, blocked: true, overrideLabel: "Overrides personas" };
    expect(personaRowMarker(all)).toEqual({ label: "Removed", tone: "muted" });
    expect(personaRowMarker({ ...all, removed: false })).toEqual({
      label: "Blocked",
      tone: "danger",
    });
    expect(personaRowMarker({ ...all, removed: false, blocked: false })).toEqual({
      label: "Overrides personas",
      tone: "muted",
    });
    expect(personaRowMarker({ removed: false, blocked: false, overrideLabel: null })).toBeNull();
  });
});
