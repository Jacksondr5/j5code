import { describe, expect, it } from "vite-plus/test";

import { rebrandTranslation, rekeyLocale, upstreamKeyOf } from "./rekey-branded-translations.ts";

describe("rekey-branded-translations", () => {
  it("swaps the brand the English changed and keeps the names J5 keeps", () => {
    expect(
      rebrandTranslation(
        '"Melde dich bei T3 Connect an, um T3 Code zu nutzen."',
        '"Sign in to T3 Connect to use T3 Code."',
        '"Sign in to T3 Connect to use J5 Code."',
      ),
    ).toBe('"Melde dich bei T3 Connect an, um J5 Code zu nutzen."');
    expect(
      rebrandTranslation('"T3-Thread lesen"', '"Read T3 thread"', '"Read J5 thread"'),
    ).toBe('"J5-Thread lesen"');
    expect(
      rebrandTranslation('"Führe `npx t3 pair` aus"', '"Run `npx t3 pair`"', '"Run `j5 pair`"'),
    ).toBe('"Führe `j5 pair` aus"');
    expect(
      rebrandTranslation(
        '"T3CODE_HOME zeigt auf das T3-Home"',
        '"T3CODE_HOME points at the T3 home"',
        '"T3CODE_HOME points at the J5 home"',
      ),
    ).toBe('"T3CODE_HOME zeigt auf das J5-Home"');
  });

  it("finds upstream's key only for a string that differs in its brand alone", () => {
    const upstream = { a: "Update T3 Code", b: "Update the app", c: ["Open ", { v: 1 }, " in T3 Code"] };
    expect(upstreamKeyOf(JSON.stringify("Update J5 Code"), upstream)).toBe("a");
    expect(upstreamKeyOf(JSON.stringify(["Open ", { v: 1 }, " in J5 Code"]), upstream)).toBe("c");
    expect(upstreamKeyOf(JSON.stringify("Update J5 Code now"), upstream)).toBeUndefined();
  });

  it("carries rebranded keys, keeps unchanged ones in en order, and drops stale ones", () => {
    const result = rekeyLocale({
      english: { same: "Settings", fresh: "Update J5 Code", j5: "Open the Inbox" },
      locale: { same: "Einstellungen", old: "T3 Code aktualisieren" },
      upstreamEnglish: { same: "Settings", old: "Update T3 Code" },
      upstreamLocale: { same: "Einstellungen", old: "T3 Code aktualisieren" },
    });
    expect(result.catalog).toEqual({ same: "Einstellungen", fresh: "J5 Code aktualisieren" });
    expect(Object.keys(result.catalog)).toEqual(["same", "fresh"]);
    expect(result.carried).toBe(1);
    expect(result.missing).toEqual(["j5"]);
  });
});
