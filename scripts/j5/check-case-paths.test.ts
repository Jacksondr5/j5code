import { expect, it } from "vite-plus/test";

import { caseCollisions } from "./check-case-paths.ts";

it("flags importable stems that differ only in case, and nothing imported by its extension", () => {
  expect(
    caseCollisions([
      "apps/mobile/src/j5/agents/PersonaSheet.tsx",
      "apps/mobile/src/j5/agents/personaSheet.ts",
      "apps/web/src/components/PdfViewer.tsx",
      "apps/web/src/components/pdfViewer.css",
      "apps/marketing/src/components/HorizonScene.astro",
      "apps/marketing/src/components/horizonScene.ts",
      "apps/web/src/j5/a2a/inboxThreadPanel.ts",
      "apps/web/src/j5/a2a/inboxThreadPanel.test.ts",
      "apps/mobile/src/j5/inbox/BellGlyph.ios.tsx",
      "apps/mobile/src/j5/inbox/BellGlyph.tsx",
    ]),
  ).toEqual([["apps/mobile/src/j5/agents/PersonaSheet", "apps/mobile/src/j5/agents/personaSheet"]]);
});
