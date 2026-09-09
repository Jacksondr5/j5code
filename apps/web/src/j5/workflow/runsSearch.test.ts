import { assert, it } from "@effect/vitest";

import { effectiveTab, effectiveView, parseRunsSearch, serializeRunsSearch } from "./runsSearch";

it("defaults to board without a run and list with one", () => {
  assert.equal(effectiveView({}), "board");
  assert.equal(effectiveView({ runId: "run" }), "list");
  assert.equal(effectiveView({ runId: "run", view: "board" }), "board");
});

it("round-trips filters and omits default values", () => {
  const parsed = parseRunsSearch({ q: "  request  ", status: "running", page: "2" });
  assert.deepEqual(parsed, {
    runId: undefined,
    squadronId: undefined,
    newWorkflow: undefined,
    view: undefined,
    q: "request",
    status: "running",
    page: 2,
    tab: undefined,
  });
  assert.deepEqual(serializeRunsSearch(parsed), { q: "request", status: "running", page: 2 });
  assert.deepEqual(serializeRunsSearch({ page: 0, tab: "overview" }), {});
});

it("forces overview for approval links and rejects invalid filters", () => {
  assert.equal(effectiveTab({ tab: "timeline" }, "#workflow-approval"), "overview");
  assert.equal(effectiveTab({ tab: "timeline" }, ""), "timeline");
  assert.equal(parseRunsSearch({ status: "nope", page: -1, q: " " }).status, undefined);
  assert.equal(parseRunsSearch({ status: "nope", page: -1, q: " " }).page, undefined);
  assert.equal(parseRunsSearch({ status: "nope", page: -1, q: " " }).q, undefined);
});
