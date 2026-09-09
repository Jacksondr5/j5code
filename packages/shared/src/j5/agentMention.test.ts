import { describe, expect, it } from "vite-plus/test";
import { detectComposerTrigger } from "../composerTrigger.ts";
import { collectComposerInlineTokens } from "../composerInlineTokens.ts";
import { agentMentionReplacement, detectAgentMention } from "./agentMention.ts";

describe("agent mention syntax", () => {
  it("recognizes the same stable agent token anywhere in a prompt", () => {
    const text = "Please ask @agent:team-researcher";
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "agent",
      query: "team-researcher",
      rangeStart: 11,
      rangeEnd: text.length,
    });
    expect(detectComposerTrigger("@agent:", 7)?.query).toBe("");
  });
  it("preserves file mentions, skills and email text", () => {
    expect(detectComposerTrigger("@src/index", 10)?.kind).toBe("path");
    expect(detectComposerTrigger("$review", 7)?.kind).toBe("skill");
    expect(detectComposerTrigger("me@example.com", 14)).toBeNull();
  });
  it("keeps agent references editable text without mistaking them for files", () => {
    expect(collectComposerInlineTokens("@agent:researcher @./src/index.ts ")).toEqual([
      expect.objectContaining({ type: "mention", value: "./src/index.ts" }),
    ]);
    expect(collectComposerInlineTokens('@"agent:notes" ')).toEqual([
      expect.objectContaining({ type: "mention", value: "agent:notes" }),
    ]);
  });

  it("round-trips the inserted replacement through the trigger detector", () => {
    const replacement = agentMentionReplacement("team-researcher");
    expect(replacement).toBe("@agent:team-researcher ");
    expect(detectAgentMention(replacement.trimEnd(), 0, replacement.length - 1)).toEqual({
      kind: "agent",
      query: "team-researcher",
      rangeStart: 0,
      rangeEnd: replacement.length - 1,
    });
  });
});
