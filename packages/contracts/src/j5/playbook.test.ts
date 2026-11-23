import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { PLAYBOOK_NAME_PATTERN, PlaybookStep, suggestPlaybookName } from "./playbook.ts";

describe("playbook step persona", () => {
  const decode = Schema.decodeUnknownSync(PlaybookStep);
  const encode = Schema.encodeSync(PlaybookStep);

  it("round-trips a step that names a persona", () => {
    const step = { id: "plan", title: "Plan", prompt: "Write the plan.", persona: "planner" };
    expect(encode(decode(step))).toStrictEqual(step);
  });

  it("decodes a step without a persona and adds no persona key", () => {
    const step = decode({ id: "plan", title: "Plan", prompt: "Write the plan." });
    expect("persona" in step).toBe(false);
  });

  it.each(["Code Reviewer", "code_reviewer", ""])("rejects malformed persona id %j", (persona) => {
    expect(() => decode({ id: "plan", title: "Plan", prompt: "Plan.", persona })).toThrow();
  });
});

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
