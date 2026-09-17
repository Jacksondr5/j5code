import { expect, it } from "vite-plus/test";
import { detectComposerTrigger as detectWeb } from "../../composer-logic";
import { detectComposerTrigger as detectShared } from "@t3tools/shared/composerTrigger";
import { splitPromptIntoComposerSegments } from "../../composer-editor-mentions";

it("keeps web and mobile agent syntax identical and removable as ordinary prompt text", () => {
  for (const text of [
    "@persona:",
    "Please @persona:team-researcher",
    "@persona:scout\n@persona:critic",
    "@agent:scout",
  ]) {
    expect(detectWeb(text, text.length)).toEqual(detectShared(text, text.length));
  }
  expect(splitPromptIntoComposerSegments("@persona:scout check this ")).toEqual([
    { type: "text", text: "@persona:scout check this " },
  ]);
});
