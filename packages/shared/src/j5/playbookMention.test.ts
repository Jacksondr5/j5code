import { describe, expect, it } from "vite-plus/test";
import { detectComposerTrigger } from "../composerTrigger.ts";
import { collectComposerInlineTokens } from "../composerInlineTokens.ts";
import { detectPlaybookMention, playbookMentionReplacement } from "./playbookMention.ts";

describe("playbook mention syntax", () => {
  it("opens the playbook picker for an @playbook: token anywhere in a message", () => {
    const text = "Use @playbook:rev";
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "slash-playbook",
      query: "rev",
      rangeStart: 4,
      rangeEnd: text.length,
    });
    expect(detectComposerTrigger("@playbook:", 10)).toMatchObject({
      kind: "slash-playbook",
      query: "",
    });
  });

  it("drops trailing punctuation from the name", () => {
    expect(detectComposerTrigger("@playbook:review,", 17)).toMatchObject({ query: "review" });
    expect(detectComposerTrigger("@playbook:review.", 17)).toMatchObject({ query: "review" });
  });

  it("closes after a space and ignores text glued before the prefix", () => {
    expect(detectComposerTrigger("@playbook:review ", 17)).toBeNull();
    expect(detectComposerTrigger("me@playbook:x", 13)).toBeNull();
  });

  it("leaves persona mentions unchanged", () => {
    expect(detectComposerTrigger("@persona:reviewer", 17)).toEqual({
      kind: "agent",
      query: "reviewer",
      rangeStart: 0,
      rangeEnd: 17,
    });
  });

  it("round-trips the inserted replacement through the detector", () => {
    const replacement = playbookMentionReplacement("release-review");
    expect(replacement).toBe("@playbook:release-review ");
    expect(detectPlaybookMention(replacement.trimEnd(), 0, replacement.length - 1)).toEqual({
      kind: "slash-playbook",
      query: "release-review",
      rangeStart: 0,
      rangeEnd: replacement.length - 1,
    });
  });

  it("keeps playbook mentions out of file chips", () => {
    expect(collectComposerInlineTokens("@playbook:review @./src/a.ts ")).toEqual([
      expect.objectContaining({ type: "mention", value: "./src/a.ts" }),
    ]);
  });
});
