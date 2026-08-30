import { describe, expect, it } from "vite-plus/test";

import {
  freezeSquadronForFirstSend,
  resolveSquadronScope,
  selectSquadronForDraft,
} from "./SquadronScope.logic";

describe("Squadron scope logic", () => {
  const choices = [
    { id: "squadron:alpha", name: "Alpha" },
    { id: "squadron:bravo", name: "Bravo" },
  ];

  it("does not invent an ambient scope", () => {
    expect(resolveSquadronScope(choices, null)).toBeNull();
    expect(resolveSquadronScope(choices, "squadron:missing")).toBeNull();
  });

  it("changes only the pre-send Squadron selection and preserves typed draft content", () => {
    const content = { prompt: "Keep this exact prompt" };
    const selected = selectSquadronForDraft(
      { squadronId: "squadron:alpha", frozenAtFirstSend: false, content },
      "squadron:bravo",
    );
    expect(selected).toEqual({ squadronId: "squadron:bravo", frozenAtFirstSend: false, content });
    expect(selected.content).toBe(content);
  });

  it("freezes the chip at first send", () => {
    const frozen = freezeSquadronForFirstSend({
      squadronId: "squadron:alpha",
      frozenAtFirstSend: false,
      content: "typed",
    });
    expect(selectSquadronForDraft(frozen, "squadron:bravo")).toBe(frozen);
  });
});
