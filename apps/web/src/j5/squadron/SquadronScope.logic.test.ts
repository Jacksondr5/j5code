import { describe, expect, it } from "vite-plus/test";

import {
  filterThreadsForSquadronScope,
  freezeSquadronForFirstSend,
  resolveSquadronDraftChipState,
  resolveSquadronScope,
  selectSquadronForDraft,
  shouldShowSquadronDraftChip,
} from "./SquadronScope.logic";

describe("Squadron scope logic", () => {
  const choices = [
    { id: "squadron:alpha", name: "Alpha", projectIds: ["project:alpha"] },
    { id: "squadron:bravo", name: "Bravo", projectIds: ["project:bravo"] },
  ];

  it("does not invent an ambient scope", () => {
    expect(resolveSquadronScope(choices, null)).toBeNull();
    expect(resolveSquadronScope(choices, "squadron:missing")).toBeNull();
  });

  it("keeps same-folder Squadrons distinct through Registrar homes, never a project proxy", () => {
    const threads = [
      { id: "thread:alpha", projectId: "project:shared" },
      { id: "thread:bravo", projectId: "project:shared" },
      { id: "thread:native", projectId: "project:shared" },
    ];
    const homes = new Map([
      ["thread:alpha", { kind: "known" as const, squadron: { id: "squadron:alpha" } }],
      ["thread:bravo", { kind: "known" as const, squadron: { id: "squadron:bravo" } }],
      ["thread:native", { kind: "unknown" as const }],
    ]);

    expect(
      filterThreadsForSquadronScope(
        threads,
        { id: "squadron:alpha", name: "Alpha", projectIds: ["project:shared"] },
        homes,
      ),
    ).toEqual([threads[0]]);
    expect(
      filterThreadsForSquadronScope(
        threads,
        { id: "squadron:bravo", name: "Bravo", projectIds: ["project:shared"] },
        homes,
      ),
    ).toEqual([threads[1]]);
  });

  it("excludes native/unknown homes while a Squadron is selected and restores them zoomed out", () => {
    const threads = [{ id: "thread:known" }, { id: "thread:native" }];
    const homes = new Map([
      ["thread:known", { kind: "known" as const, squadron: { id: "squadron:alpha" } }],
      ["thread:native", { kind: "unknown" as const }],
    ]);

    expect(
      filterThreadsForSquadronScope(
        threads,
        { id: "squadron:alpha", name: "Alpha", projectIds: [] },
        homes,
      ),
    ).toEqual([threads[0]]);
    expect(filterThreadsForSquadronScope(threads, null, homes)).toEqual(threads);
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

  it("keeps only a frozen J5 choice visible after send", () => {
    expect(shouldShowSquadronDraftChip({ isFirstMessage: true, frozenAtFirstSend: false })).toBe(
      true,
    );
    expect(shouldShowSquadronDraftChip({ isFirstMessage: false, frozenAtFirstSend: true })).toBe(
      true,
    );
    expect(shouldShowSquadronDraftChip({ isFirstMessage: false, frozenAtFirstSend: false })).toBe(
      false,
    );
  });

  it("uses a durable known Registrar home for a fresh thread chip", () => {
    expect(
      resolveSquadronDraftChipState({
        durableHome: { id: "squadron:alpha", name: "Alpha" },
        draft: { squadronId: null, frozenAtFirstSend: false },
        isFirstMessage: false,
      }),
    ).toEqual({ visible: true, frozen: true, squadronId: "squadron:alpha" });
  });

  it("keeps unknown/native existing threads chip-free and preserves pre-send draft behavior", () => {
    expect(
      resolveSquadronDraftChipState({
        durableHome: null,
        draft: { squadronId: null, frozenAtFirstSend: false },
        isFirstMessage: false,
      }),
    ).toEqual({ visible: false, frozen: false, squadronId: null });
    expect(
      resolveSquadronDraftChipState({
        durableHome: null,
        draft: { squadronId: "squadron:bravo", frozenAtFirstSend: false },
        isFirstMessage: true,
      }),
    ).toEqual({ visible: true, frozen: false, squadronId: "squadron:bravo" });
  });
});
