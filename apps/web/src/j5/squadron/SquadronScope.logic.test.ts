import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";

import { filterThreadsForSquadronScope, resolveSquadronScope } from "./SquadronScope.logic";

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
});

describe("SB5 sidebar membership", () => {
  const known = (id: string, origin?: "human" | "agent") => ({
    kind: "known" as const,
    squadron: { id },
    ...(origin === undefined ? {} : { origin }),
  });
  const key = (id: string) => scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)));
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
