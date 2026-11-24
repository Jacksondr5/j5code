import { describe, expect, it } from "vite-plus/test";

import {
  PHRASES,
  rebrandTranslation,
  rekeyLocale,
  upstreamKeyOf,
} from "./rekey-branded-translations.ts";

describe("rekey-branded-translations", () => {
  it("swaps the brand the English changed and keeps the names J5 keeps", () => {
    expect(
      rebrandTranslation(
        '"Melde dich bei T3 Connect an, um T3 Code zu nutzen."',
        '"Sign in to T3 Connect to use T3 Code."',
        '"Sign in to T3 Connect to use J5 Code."',
      ),
    ).toBe('"Melde dich bei T3 Connect an, um J5 Code zu nutzen."');
    expect(rebrandTranslation('"T3-Thread lesen"', '"Read T3 thread"', '"Read J5 thread"')).toBe(
      '"J5-Thread lesen"',
    );
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

  it("carries a bare T3 that became J5 Code, t3@ that became j5, and a rewritten sentence", () => {
    expect(
      upstreamKeyOf(JSON.stringify("J5 Code requests zero data retention"), {
        a: "T3 requests zero data retention",
      }),
    ).toBe("a");
    expect(
      upstreamKeyOf(JSON.stringify("Reconnected on j5 {version}."), {
        a: "Reconnected on t3@{version}.",
      }),
    ).toBe("a");
    expect(
      rebrandTranslation(
        '"Mit t3@{version} neu verbunden."',
        '"Reconnected on t3@{version}."',
        '"Reconnected on j5 {version}."',
      ),
    ).toBe('"Mit j5 {version} neu verbunden."');
    expect(
      rebrandTranslation(
        '"Zum Beispiel ergibt t3 oder t3/ den Namen t3/add-search."',
        '"For example, t3 or t3/ produces t3/add-search."',
        '"For example, j5code or j5code/ produces j5code/add-search."',
      ),
      "a branch prefix the English made j5code",
    ).toBe('"Zum Beispiel ergibt j5code oder j5code/ den Namen j5code/add-search."');
    const [rewrite] = PHRASES;
    if (rewrite === undefined) throw new Error("no phrases");
    const oldEnglish = `Stop it. ${rewrite.english.upstream}. Then reopen T3 Code.`;
    const newEnglish = `Stop it. ${rewrite.english.j5}. Then reopen J5 Code.`;
    expect(upstreamKeyOf(JSON.stringify(newEnglish), { a: oldEnglish })).toBe("a");
    expect(
      rebrandTranslation(
        JSON.stringify(`Stoppe ihn. ${rewrite.locales.de!.upstream}. Öffne T3 Code dann erneut.`),
        JSON.stringify(oldEnglish),
        JSON.stringify(newEnglish),
        "de",
      ),
    ).toBe(JSON.stringify(`Stoppe ihn. ${rewrite.locales.de!.j5}. Öffne J5 Code dann erneut.`));
  });

  it("finds upstream's key only for a string that differs in its brand alone", () => {
    const upstream = {
      a: "Update T3 Code",
      b: "Update the app",
      c: ["Open ", { v: 1 }, " in T3 Code"],
    };
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

  it("replaces the English fallback `gt generate` writes for a key it has not seen", () => {
    const result = rekeyLocale({
      english: { fresh: "Update J5 Code", j5: "Open the Inbox" },
      locale: { fresh: "Update J5 Code", j5: "Open the Inbox" },
      upstreamEnglish: { old: "Update T3 Code" },
      upstreamLocale: { old: "T3 Code aktualisieren" },
    });
    expect(result.catalog).toEqual({ fresh: "J5 Code aktualisieren", j5: "Open the Inbox" });
    expect(result.missing).toEqual([]);
    expect(result.leftEnglish).toEqual(["j5"]);
  });
});
