import { assert, it } from "@effect/vitest";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  retainNewestRunDetail,
  retainWorkflowListReference,
  isPollableWorkflowAtom,
  shouldPollWorkflowQueries,
  workflowArtifactAtom,
  workflowDetailAtom,
  workflowListAtom,
  workflowIntervalTransition,
  workflowDefinitionsQuery,
  workflowApprovalCountQuery,
} from "./queries";

const environmentId = "environment:one" as EnvironmentId;

it("deduplicates complete workflow query keys and separates obsolete selections", () => {
  const list = {
    environmentId,
    input: { squadronId: "s", search: "term", status: "running", page: 2, pageSize: 50 },
  } as const;
  assert.strictEqual(workflowListAtom(list), workflowListAtom(list));
  assert.notStrictEqual(
    workflowListAtom(list),
    workflowListAtom({ ...list, input: { ...list.input, search: "new" } }),
  );
  assert.notStrictEqual(
    workflowDetailAtom({ environmentId, input: { runId: "one" } }),
    workflowDetailAtom({ environmentId, input: { runId: "two" } }),
  );
  const artifact = {
    id: "artifact",
    hash: "hash-one",
    producer: "agent",
    phase: "plan",
    revision: 1,
    attempt: 1,
    governs: [],
  } as const;
  assert.strictEqual(
    workflowArtifactAtom({ environmentId, input: { runId: "one", artifact } }),
    workflowArtifactAtom({ environmentId, input: { runId: "one", artifact } }),
  );
  assert.notStrictEqual(
    workflowArtifactAtom({ environmentId, input: { runId: "one", artifact } }),
    workflowArtifactAtom({
      environmentId: "environment:two" as EnvironmentId,
      input: { runId: "one", artifact },
    }),
  );
});

it("classifies only periodically refreshed workflow queries as pollable", () => {
  assert.isTrue(
    isPollableWorkflowAtom(
      workflowListAtom({
        environmentId,
        input: { squadronId: "", search: "", status: "", page: 0, pageSize: 50 },
      }),
    ),
  );
  assert.isTrue(
    isPollableWorkflowAtom(workflowDetailAtom({ environmentId, input: { runId: "run" } })),
  );
  assert.isTrue(isPollableWorkflowAtom(workflowApprovalCountQuery(environmentId)));
  assert.isFalse(isPollableWorkflowAtom(workflowDefinitionsQuery(environmentId)));
  assert.isFalse(
    isPollableWorkflowAtom(
      workflowArtifactAtom({
        environmentId,
        input: {
          runId: "run",
          artifact: {
            id: "a",
            hash: "h",
            producer: "p",
            phase: "x",
            revision: 1,
            attempt: 1,
            governs: [],
          },
        },
      }),
    ),
  );
});

it("retains stable references and rejects out-of-order detail responses", () => {
  const entries = {
    runs: [],
    hasMore: false,
    updatedAt: "2026-09-08T00:00:00Z",
    total: 0,
    waitingApprovalCount: 0,
  } as const;
  assert.strictEqual(
    retainWorkflowListReference("stable", entries),
    retainWorkflowListReference("stable", { ...entries }),
  );
  const current = { id: "run", readVersion: 4 } as never;
  assert.strictEqual(retainNewestRunDetail(current, null), current);
  assert.strictEqual(
    retainNewestRunDetail(current, { id: "run", readVersion: 3 } as never),
    current,
  );
});

it("replaces a retained list when any workflow entry field changes", () => {
  const entry = {
    id: "run",
    squadronId: "squadron",
    revision: 1,
    gateRevision: null,
    status: "running",
    updatedAt: "2026-09-08T00:00:00Z",
    title: "Title",
    phase: "plan",
  } as const;
  const value = { runs: [entry], hasMore: false, total: 1, waitingApprovalCount: 0 } as const;
  const fields = {
    id: "other",
    squadronId: "other",
    revision: 2,
    gateRevision: 1,
    status: "blocked",
    updatedAt: "2026-09-08T00:01:00Z",
    title: "Other",
    phase: "build",
  } as const;
  for (const [field, changed] of Object.entries(fields)) {
    const key = `changed-${field}`;
    const retained = retainWorkflowListReference(key, value);
    const next = retainWorkflowListReference(key, {
      ...value,
      runs: [{ ...entry, [field]: changed }],
    } as never);
    assert.notStrictEqual(next, retained, field);
  }
  for (const [field, changed] of Object.entries({
    hasMore: true,
    total: 2,
    waitingApprovalCount: 1,
  })) {
    const key = `changed-list-${field}`;
    const retained = retainWorkflowListReference(key, value);
    const next = retainWorkflowListReference(key, { ...value, [field]: changed } as never);
    assert.notStrictEqual(next, retained, field);
  }
});

it("does not schedule periodic workflow reads while hidden or unsubscribed", () => {
  assert.isFalse(shouldPollWorkflowQueries("hidden", 2));
  assert.isFalse(shouldPollWorkflowQueries("visible", 0));
  assert.isTrue(shouldPollWorkflowQueries("visible", 1));
});

it("keeps an existing poll schedule across non-pollable subscription changes", () => {
  assert.equal(workflowIntervalTransition(true, "visible", 1), "keep");
  assert.equal(workflowIntervalTransition(false, "visible", 0), "keep");
  assert.equal(workflowIntervalTransition(false, "visible", 1), "start");
  assert.equal(workflowIntervalTransition(true, "hidden", 1), "stop");
  assert.equal(workflowIntervalTransition(false, "hidden", 1), "keep");
});
