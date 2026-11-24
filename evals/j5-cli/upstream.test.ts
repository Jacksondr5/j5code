import { assert, it } from "@effect/vitest";

import { loadCases, sampleFor, splitConversation, t3McpTools } from "./upstream.ts";

const one = (id: string, catalog: "j5" | "upstream" = "j5") => {
  const [testCase] = loadCases([id], catalog);
  if (testCase === undefined) throw new Error(`No case ${id}.`);
  return testCase;
};
const text = (history: ReturnType<typeof splitConversation>["history"]) =>
  JSON.stringify(history.flatMap((message) => message.content));

it("splits earlier turns from the live prompt and drops the template's own context", () => {
  const testCase = one("review-round-uses-thread-send");
  const { history, prompt } = splitConversation(sampleFor(testCase, "claude-sonnet-5-5"));
  assert.strictEqual(prompt, testCase.prompt);
  assert.include(text(history), "Sol round 1 is back");
  assert.notInclude(text(history), testCase.prompt);
  assert.notInclude(text(history), "# gitStatus");
});

it("keeps a case's own notes in the earlier turns", () => {
  const testCase = loadCases([], "upstream").find(
    ({ setup }) => setup.context !== undefined && (setup.priorTurns ?? []).length === 0,
  );
  if (testCase?.setup.context === undefined) throw new Error("No case with context.");
  const { history } = splitConversation(sampleFor(testCase, "claude-sonnet-5-5"));
  assert.include(text(history), JSON.stringify(testCase.setup.context).slice(1, 40));
});

it("runs J5's version of a case in place of the upstream one it replaces", () => {
  const ids = (catalog: "j5" | "upstream") => loadCases([], catalog).map(({ id }) => id);
  assert.include(ids("j5"), "j5-tt-thread-in-another-project");
  assert.notInclude(ids("j5"), "tt-thread-in-another-project");
  assert.include(ids("upstream"), "tt-thread-in-another-project");
  assert.notInclude(ids("upstream"), "j5-tt-thread-in-another-project");
});

it("lists each catalog's tools by their own visibility rules", () => {
  const names = (id: string, catalog: "j5" | "upstream") =>
    t3McpTools(one(id, catalog), catalog).map(({ name }) => name);
  const top = names("review-round-uses-thread-send", "j5");
  assert.include(top, "j5_spawn_agent");
  assert.notInclude(top, "t3_thread_launch");
  assert.notInclude(top, "t3_thread_send");
  assert.include(names("review-round-uses-thread-send", "upstream"), "t3_thread_send");
  const child = loadCases([], "j5").find(({ setup }) => setup.role === "delegated-child");
  if (child === undefined) throw new Error("No delegated-child case.");
  assert.isBelow(t3McpTools(child, "j5").length, top.length);
});
