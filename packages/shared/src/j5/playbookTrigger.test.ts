import { describe, expect, it } from "vite-plus/test";
import { detectPlaybookTrigger } from "./playbookTrigger.ts";

describe("detectPlaybookTrigger", () => {
  it.each([
    ["/playbook ", "", "", ""],
    ["/PLAYBOOK\treview", "", "", "review"],
    ["/playbook code-r", "\n", " then summarize", "code-r"],
  ])("detects %j with surrounding text", (prefix, before, after, query) => {
    expect(detectPlaybookTrigger(prefix, before, after)).toEqual({
      kind: "slash-playbook",
      query,
      rangeStart: before.length,
      rangeEnd: before.length + prefix.length,
    });
  });

  it.each([
    ["/playbook review", "Earlier text\n", ""],
    ["/playbook review then", "", ""],
    ["/playbook rev", "", "iew"],
    ["/playbook review,", "", ""],
    ["/playbooks review", "", ""],
    ["/playbook", "", ""],
  ])("does not treat %j as an active name query", (prefix, before, after) => {
    expect(detectPlaybookTrigger(prefix, before, after)).toBeNull();
  });
});
