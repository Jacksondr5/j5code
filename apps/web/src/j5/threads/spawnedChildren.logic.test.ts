import { describe, expect, it } from "vite-plus/test";

import { readExpandedSpawnParents, writeExpandedSpawnParents } from "./spawnedChildren.logic";

describe("spawned children expansion", () => {
  it("remembers expansion per parent and tolerates broken or missing storage", () => {
    const backing = new Map<string, string>();
    const storage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
    };
    writeExpandedSpawnParents(storage, new Set(["captain"]));
    expect([...readExpandedSpawnParents(storage)]).toEqual(["captain"]);
    backing.set("j5:sidebar:spawned-children:expanded", "{not json");
    expect(readExpandedSpawnParents(storage).size).toBe(0);
    expect(readExpandedSpawnParents(undefined).size).toBe(0);
  });
});
