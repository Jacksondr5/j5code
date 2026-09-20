import { expect, it } from "vite-plus/test";
import { detectComposerTrigger as detectWeb } from "../../composer-logic";
import { detectComposerTrigger as detectShared } from "@t3tools/shared/composerTrigger";
import { splitPromptIntoComposerSegments } from "../../composer-editor-mentions";

it("keeps web and mobile agent syntax identical and removable as ordinary prompt text", () => {
  for (const text of ["@agent:", "Please @agent:team-researcher", "@agent:scout\n@agent:critic"]) {
    expect(detectWeb(text, text.length)).toEqual(detectShared(text, text.length));
  }
  expect(splitPromptIntoComposerSegments("@agent:scout check this ")).toEqual([
    { type: "text", text: "@agent:scout check this " },
  ]);
});
