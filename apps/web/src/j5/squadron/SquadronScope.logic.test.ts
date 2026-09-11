import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";

import {
  filterThreadsForSquadronScope,
  freezeSquadronForFirstSend,
  resolveEffectiveSquadronId,
  resolveSquadronDraftChipState,
  resolveSquadronScope,
  selectSquadronForDraft,
  shouldShowSquadronDraftChip,
} from "./SquadronScope.logic";

const environmentId = EnvironmentId.make("remote");
const homeKey = (threadId: string) =>
  scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(threadId)));

describe("Squadron scope logic", () => {
  const choices = [
    { environmentId, id: "squadron:alpha", name: "Alpha" },
    { environmentId, id: "squadron:bravo", name: "Bravo" },
  ];

  it("does not invent an ambient scope", () => {
    expect(resolveSquadronScope(choices, null)).toBeNull();
    expect(
      resolveSquadronScope(choices, { environmentId, squadronId: "squadron:missing" }),
    ).toBeNull();
  });

  it("keeps same-folder Squadrons distinct through Registrar homes, never a project proxy", () => {
    const threads = [
      { environmentId, id: "thread:alpha", projectId: "project:shared" },
      { environmentId, id: "thread:bravo", projectId: "project:shared" },
      { environmentId, id: "thread:native", projectId: "project:shared" },
    ];
    const homes = new Map([
      [homeKey("thread:alpha"), { kind: "known" as const, squadron: { id: "squadron:alpha" } }],
      [homeKey("thread:bravo"), { kind: "known" as const, squadron: { id: "squadron:bravo" } }],
      [homeKey("thread:native"), { kind: "unknown" as const }],
    ]);

    expect(
      filterThreadsForSquadronScope(
        threads,
        { environmentId, id: "squadron:alpha", name: "Alpha" },
        homes,
      ),
    ).toEqual([threads[0]]);
    expect(
      filterThreadsForSquadronScope(
        threads,
        { environmentId, id: "squadron:bravo", name: "Bravo" },
        homes,
      ),
    ).toEqual([threads[1]]);
  });

  it("excludes native/unknown homes while a Squadron is selected and restores them zoomed out", () => {
    const threads = [
      { environmentId, id: "thread:known" },
      { environmentId, id: "thread:native" },
    ];
    const homes = new Map([
      [homeKey("thread:known"), { kind: "known" as const, squadron: { id: "squadron:alpha" } }],
      [homeKey("thread:native"), { kind: "unknown" as const }],
    ]);

    expect(
      filterThreadsForSquadronScope(
        threads,
        { environmentId, id: "squadron:alpha", name: "Alpha" },
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

  it("uses a durable Registrar home before draft or ambient context on a zero-message thread", () => {
    expect(
      resolveEffectiveSquadronId({
        durableHome: { id: "squadron:alpha", name: "Alpha" },
        draftSquadronId: "squadron:bravo",
        ambientSquadronId: "squadron:bravo",
      }),
    ).toBe("squadron:alpha");
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

it("keeps a Squadron scope within its own environment even when IDs match", () => {
  const otherEnvironment = EnvironmentId.make("other");
  const threads = [
    { environmentId, id: "thread:same" },
    { environmentId: otherEnvironment, id: "thread:same" },
  ];
  const homes = new Map(
    threads.map((thread) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, ThreadId.make(thread.id))),
      { kind: "known" as const, squadron: { id: "squadron:same" } },
    ]),
  );
  expect(
    filterThreadsForSquadronScope(
      threads,
      { environmentId: otherEnvironment, id: "squadron:same", name: "Other" },
      homes,
    ),
  ).toEqual([threads[1]]);
  expect(
    resolveSquadronScope([{ environmentId, id: "squadron:same", name: "Local" }], {
      environmentId: otherEnvironment,
      squadronId: "squadron:same",
    }),
  ).toBeNull();
});
