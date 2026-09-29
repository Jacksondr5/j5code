import { describe, expect, it } from "@effect/vitest";

import { PLAYBOOK_NAME_PATTERN, suggestPlaybookName } from "./playbook.ts";

describe("playbook names", () => {
  it.each(["release", "release-review", "v2-plan"])("accepts %s", (name) => {
    expect(PLAYBOOK_NAME_PATTERN.test(name)).toBe(true);
  });

  it.each(["Release", "release plan", "release_notes", "-release", "release-", "2026-plan", ""])(
    "rejects %j",
    (name) => {
      expect(PLAYBOOK_NAME_PATTERN.test(name)).toBe(false);
    },
  );

  it.each([
    ["Release Plan", "release-plan"],
    ["release_notes", "release-notes"],
    ["Révision v2", "revision-v2"],
    ["2026 plan", "playbook-2026-plan"],
    ["!!!", null],
  ])("suggests a valid name for %j", (text, expected) => {
    const suggestion = suggestPlaybookName(text);
    expect(suggestion).toBe(expected);
    if (suggestion) expect(PLAYBOOK_NAME_PATTERN.test(suggestion)).toBe(true);
  });
});
