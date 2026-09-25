import { describe, expect, it } from "vite-plus/test";
import { detectComposerTrigger } from "../composerTrigger.ts";
import { collectComposerInlineTokens } from "../composerInlineTokens.ts";
import { agentMentionReplacement, detectAgentMention } from "./agentMention.ts";

describe("agent mention syntax", () => {
  it("recognizes the same stable persona token anywhere in a prompt", () => {
    const text = "Please ask @persona:team-researcher";
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "agent",
      query: "team-researcher",
      rangeStart: 11,
      rangeEnd: text.length,
    });
    expect(detectComposerTrigger("@persona:", 9)?.query).toBe("");
    // Only the persona spelling is a mention; no pre-dogfood spelling is kept alive.
    expect(detectComposerTrigger("@agent:scout", 12)?.kind).not.toBe("agent");
  });
  it("preserves file mentions, skills and email text", () => {
    expect(detectComposerTrigger("@src/index", 10)?.kind).toBe("path");
    expect(detectComposerTrigger("$review", 7)?.kind).toBe("skill");
    expect(detectComposerTrigger("me@example.com", 14)).toBeNull();
  });
  it("searches playbook names after /playbook", () => {
    const text = "/playbook debug";
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "slash-playbook",
      query: "debug",
      rangeStart: 0,
      rangeEnd: text.length,
    });
    expect(detectComposerTrigger("/playbook debugging ", 20)).toBeNull();
  });
  it("keeps agent references editable text without mistaking them for files", () => {
    expect(collectComposerInlineTokens("@persona:researcher @./src/index.ts ")).toEqual([
      expect.objectContaining({ type: "mention", value: "./src/index.ts" }),
    ]);
    expect(collectComposerInlineTokens('@"persona:notes" ')).toEqual([
      expect.objectContaining({ type: "mention", value: "persona:notes" }),
    ]);
  });

  it("round-trips the inserted replacement through the trigger detector", () => {
    const replacement = agentMentionReplacement("team-researcher");
    expect(replacement).toBe("@persona:team-researcher ");
    expect(detectAgentMention(replacement.trimEnd(), 0, replacement.length - 1)).toEqual({
      kind: "agent",
      query: "team-researcher",
      rangeStart: 0,
      rangeEnd: replacement.length - 1,
    });
  });
});
