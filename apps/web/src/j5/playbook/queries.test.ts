import { assert, it } from "@effect/vitest";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  retainBoardReference,
  retainNewestRunDetail,
  retainTimelinePage,
  retainPlaybookListReference,
  isPollablePlaybookAtom,
  shouldPollPlaybookQueries,
  playbookArtifactAtom,
  playbookBoardAtom,
  playbookDetailAtom,
  playbookListAtom,
  playbookTimelineAtom,
  playbookIntervalTransition,
  playbookDefinitionsQuery,
  playbookApprovalCountQuery,
} from "./queries";

const environmentId = "environment:one" as EnvironmentId;

it("deduplicates complete playbook query keys and separates obsolete selections", () => {
  const list = {
    environmentId,
    input: { squadronId: "s", search: "term", status: "running", page: 2, pageSize: 50 },
  } as const;
  assert.strictEqual(playbookListAtom(list), playbookListAtom(list));
  assert.notStrictEqual(
    playbookListAtom(list),
    playbookListAtom({ ...list, input: { ...list.input, search: "new" } }),
  );
  assert.notStrictEqual(
    playbookDetailAtom({ environmentId, input: { runId: "one" } }),
    playbookDetailAtom({ environmentId, input: { runId: "two" } }),
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
    playbookArtifactAtom({ environmentId, input: { runId: "one", artifact } }),
    playbookArtifactAtom({ environmentId, input: { runId: "one", artifact } }),
  );
  assert.notStrictEqual(
    playbookArtifactAtom({ environmentId, input: { runId: "one", artifact } }),
    playbookArtifactAtom({
      environmentId: "environment:two" as EnvironmentId,
      input: { runId: "one", artifact },
    }),
  );
});

it("classifies only periodically refreshed playbook queries as pollable", () => {
  assert.isTrue(
    isPollablePlaybookAtom(
      playbookListAtom({
        environmentId,
        input: { squadronId: "", search: "", status: "", page: 0, pageSize: 50 },
      }),
    ),
  );
  assert.isTrue(
    isPollablePlaybookAtom(playbookDetailAtom({ environmentId, input: { runId: "run" } })),
  );
  assert.isTrue(isPollablePlaybookAtom(playbookApprovalCountQuery(environmentId)));
  assert.isTrue(
    isPollablePlaybookAtom(
      playbookBoardAtom({
        environmentId,
        input: { squadronId: "", search: "", status: "", page: 0, pageSize: 24 },
      }),
    ),
  );
  assert.isTrue(
    isPollablePlaybookAtom(
      playbookTimelineAtom({ environmentId, input: { runId: "run", before: null } }),
    ),
  );
  assert.isFalse(
    isPollablePlaybookAtom(
      playbookTimelineAtom({ environmentId, input: { runId: "run", before: 10 } }),
    ),
  );
  assert.isFalse(isPollablePlaybookAtom(playbookDefinitionsQuery(environmentId)));
  assert.isFalse(
    isPollablePlaybookAtom(
      playbookArtifactAtom({
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

const boardCard = {
  id: "run",
  squadronId: "squadron",
  title: "Build a board",
  phase: "plan",
  status: "running",
  revision: 2,
  readVersion: 3,
  gateRevision: null,
  updatedAt: "2026-09-09T00:00:00Z",
  definitionId: "fh-development",
  definitionVersion: 1,
  definitionHash: "hash",
  visit: 1,
  visits: { plan: 1 },
  failureCategory: null,
  actions: [
    {
      actionId: "action",
      phase: "plan",
      task: "Planner",
      attempt: 1,
      actionKind: "agent",
      actionStatus: "claimed",
      deadline: 1,
      threadId: "thread",
      sessionRunId: "provider",
      sessionStatus: "running",
      requestedAt: "2026-09-09T00:00:00Z",
      completedAt: null,
    },
  ],
} as const;

it("retains board pages and reuses unchanged card objects", () => {
  const first = retainBoardReference("board-stable", {
    cards: [boardCard],
    hasMore: false,
    total: 1,
    waitingApprovalCount: 0,
  });
  assert.strictEqual(
    retainBoardReference("board-stable", { ...first, cards: [{ ...boardCard }] }),
    first,
  );
  const countChanged = retainBoardReference("board-stable", { ...first, total: 2 });
  assert.notStrictEqual(countChanged, first);
  assert.strictEqual(countChanged.cards[0], first.cards[0]);
  const sessionChanged = retainBoardReference("board-stable", {
    ...countChanged,
    cards: [
      {
        ...boardCard,
        actions: [{ ...boardCard.actions[0], sessionStatus: "completed" }],
      },
    ],
  });
  assert.notStrictEqual(sessionChanged.cards[0], first.cards[0]);
});

it("keys timeline pages by run and cursor and retains non-newer heads", () => {
  const head = playbookTimelineAtom({ environmentId, input: { runId: "run", before: null } });
  assert.strictEqual(
    head,
    playbookTimelineAtom({ environmentId, input: { runId: "run", before: null } }),
  );
  assert.notStrictEqual(
    head,
    playbookTimelineAtom({ environmentId, input: { runId: "run", before: 4 } }),
  );
  const page = {
    runId: "run",
    headRevision: 4,
    readVersion: 5,
    revisions: [],
    nextBefore: null,
  } as const;
  assert.strictEqual(
    retainTimelinePage("timeline-stable", page),
    retainTimelinePage("timeline-stable", { ...page }),
  );
  assert.notStrictEqual(
    retainTimelinePage("timeline-stable", { ...page, headRevision: 5, readVersion: 6 }),
    page,
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
    retainPlaybookListReference("stable", entries),
    retainPlaybookListReference("stable", { ...entries }),
  );
  const current = { id: "run", readVersion: 4 } as never;
  assert.strictEqual(retainNewestRunDetail(current, null), current);
  assert.strictEqual(
    retainNewestRunDetail(current, { id: "run", readVersion: 3 } as never),
    current,
  );
});

it("replaces a retained list when any playbook entry field changes", () => {
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
    const retained = retainPlaybookListReference(key, value);
    const next = retainPlaybookListReference(key, {
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
    const retained = retainPlaybookListReference(key, value);
    const next = retainPlaybookListReference(key, { ...value, [field]: changed } as never);
    assert.notStrictEqual(next, retained, field);
  }
});

it("does not schedule periodic playbook reads while hidden or unsubscribed", () => {
  assert.isFalse(shouldPollPlaybookQueries("hidden", 2));
  assert.isFalse(shouldPollPlaybookQueries("visible", 0));
  assert.isTrue(shouldPollPlaybookQueries("visible", 1));
});

it("keeps an existing poll schedule across non-pollable subscription changes", () => {
  assert.equal(playbookIntervalTransition(true, "visible", 1), "keep");
  assert.equal(playbookIntervalTransition(false, "visible", 0), "keep");
  assert.equal(playbookIntervalTransition(false, "visible", 1), "start");
  assert.equal(playbookIntervalTransition(true, "hidden", 1), "stop");
  assert.equal(playbookIntervalTransition(false, "hidden", 1), "keep");
});
