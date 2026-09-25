import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";

import { resolveFirstSendSquadronCarrier } from "../../components/ChatView.logic";

import {
  filterThreadsForSquadronScope,
  freezeSquadronForFirstSend,
  resolveEffectiveSquadronId,
  resolveSquadronDraftChipState,
  resolveSquadronScope,
  selectSquadronForDraft,
  shouldShowSquadronDraftChip,
  isSidebarMember,
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

  it("uses a durable Registrar home before the draft choice on a zero-message thread", () => {
    expect(
      resolveEffectiveSquadronId({
        durableHome: { id: "squadron:alpha", name: "Alpha" },
        draftSquadronId: "squadron:bravo",
      }),
    ).toBe("squadron:alpha");
  });

  it("names exactly the Squadron first send would carry, never the ambient scope", () => {
    const durableHomes = [null, { id: "squadron:alpha", name: "Alpha" }] as const;
    const draftIds = [null, "squadron:bravo"] as const;
    for (const durableHome of durableHomes) {
      for (const draftSquadronId of draftIds) {
        // An ambient scope is set in every case; the add-folder draft that showed it was refused.
        const carrier = resolveFirstSendSquadronCarrier({
          durableSquadronId: durableHome?.id ?? null,
          draftSquadronId,
          ambientSquadronId: "squadron:homelab",
        });
        expect(resolveEffectiveSquadronId({ durableHome, draftSquadronId })).toBe(
          carrier.kind === "missing-explicit-squadron" ? null : carrier.squadronId,
        );
      }
    }
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

describe("SB5 sidebar membership", () => {
  const known = (id: string, origin?: "human" | "agent") => ({
    kind: "known" as const,
    squadron: { id },
    ...(origin === undefined ? {} : { origin }),
  });
  const key = (id: string) => scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)));
  it("hides agent-spawned peers unless pinned and keeps human, unknown, and silent homes", () => {
    expect(isSidebarMember({ pinnedAt: null }, known("s", "agent"))).toBe(false);
    expect(isSidebarMember({ pinnedAt: "2026-09-09T00:00:00Z" }, known("s", "agent"))).toBe(true);
    expect(isSidebarMember({ pinnedAt: null }, known("s", "human"))).toBe(true);
    expect(isSidebarMember({ pinnedAt: null }, known("s"))).toBe(true);
    expect(isSidebarMember({ pinnedAt: null }, { kind: "unknown" })).toBe(true);
    expect(isSidebarMember({ pinnedAt: null }, undefined)).toBe(true);
  });
  it("applies membership before the squadron scope, including when zoomed out", () => {
    const homes = new Map([
      [key("captain"), known("alpha", "human")],
      [key("member"), known("alpha", "agent")],
      [key("pinned-member"), known("alpha", "agent")],
      [key("other"), known("bravo", "human")],
    ]);
    const threads = [
      { environmentId, id: "captain", pinnedAt: null },
      { environmentId, id: "member", pinnedAt: null },
      { environmentId, id: "pinned-member", pinnedAt: "2026-09-09T00:00:00Z" },
      { environmentId, id: "other", pinnedAt: null },
      { environmentId, id: "native", pinnedAt: null },
    ];
    expect(filterThreadsForSquadronScope(threads, null, homes).map(({ id }) => id)).toEqual([
      "captain",
      "pinned-member",
      "other",
      "native",
    ]);
    expect(
      filterThreadsForSquadronScope(
        threads,
        { environmentId, id: "alpha", name: "Alpha" },
        homes,
      ).map(({ id }) => id),
    ).toEqual(["captain", "pinned-member"]);
  });
});
