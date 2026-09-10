import { assert, it } from "@effect/vitest";
import type { RunDetail } from "@j5/workflow-contracts";

import {
  appliedDraftFor,
  appliedFeedbackFor,
  findDefinition,
  gateArtifactMetadata,
  groupActionsByPhase,
  hasOpenActions,
  metadataFrom,
  nonGateArtifacts,
  publicationValidationFor,
  sameMetadata,
  splitGateArtifacts,
  visibleArtifactMetadata,
} from "./runDetailModel";

const artifact = (id: string, phase: string, content: unknown = {}) => ({
  id,
  phase,
  content,
  hash: `hash-${id}`,
  producer: "agent",
  revision: 1,
  attempt: 1,
  governs: [],
});
const runValue = {
  id: "run",
  definitionId: "definition",
  definitionVersion: 2,
  definitionHash: "definition-hash",
  squadronId: "squadron",
  projectId: "project",
  repository: "repo",
  baseCommit: "base",
  request: "request",
  phase: "publication_approval",
  revision: 4,
  readVersion: 7,
  status: "waiting_approval",
  cause: null,
  recovery: null,
  restartAvailability: {
    available: false,
    reason: "Not timed out",
    targetDefinitionHash: "definition-hash",
    nextVisit: null,
    maxVisits: null,
    compatibleDefinitionUpgrade: false,
  },
  approvals: [],
  visits: {},
  gate: { revision: 3, artifactHash: "gate-hash", artifactIds: ["review", "metadata", "review"] },
  artifacts: [
    artifact("metadata", "metadata"),
    artifact("old", "validation", { codeIdentity: "old" }),
    artifact("review", "review", { verdict: "accept" }),
    artifact("validation", "validation", { codeIdentity: "candidate" }),
  ],
  actions: [],
};
const run = runValue as RunDetail;

it("derives artifact ordering, gate identity, and publication validation", () => {
  assert.deepEqual(
    gateArtifactMetadata(run).map((item) => item.id),
    ["review", "metadata", "review"],
  );
  assert.deepEqual(
    visibleArtifactMetadata(run).map((item) => item.id),
    ["review", "metadata", "validation"],
  );
  const loaded = [
    artifact("review", "review", { verdict: "accept" }),
    artifact("metadata", "metadata", { codeIdentity: "candidate" }),
    artifact("validation", "validation", { codeIdentity: "candidate" }),
  ];
  assert.equal(publicationValidationFor(run, loaded.slice(0, 2), loaded)?.id, "validation");
  assert.isUndefined(
    publicationValidationFor({ ...runValue, phase: "plan_approval" } as RunDetail, loaded, loaded),
  );
  assert.deepEqual(splitGateArtifacts(loaded), {
    reviews: [loaded[0]!],
    evidence: [loaded[1]!, loaded[2]!],
  });
  assert.deepEqual(
    nonGateArtifacts(run).map((item) => item.id),
    ["old", "validation"],
  );
});

it("preserves action phase and action order", () => {
  const actions = [
    { id: "1", phase: "plan", status: "completed" },
    { id: "2", phase: "build", status: "claimed" },
    { id: "3", phase: "plan", status: "blocked" },
  ] as never;
  assert.deepEqual(
    groupActionsByPhase(actions).map((group) => [
      group.phase,
      group.actions.map((item) => item.id),
    ]),
    [
      ["plan", ["1", "3"]],
      ["build", ["2"]],
    ],
  );
  assert.isTrue(hasOpenActions(actions));
  assert.isFalse(hasOpenActions([{ id: "4", phase: "done", status: "completed" }] as never));
});

it("matches definitions and keeps drafts tied to run, gate revision, and hash", () => {
  const definition = { id: "definition", version: 2, hash: "definition-hash" } as never;
  assert.strictEqual(findDefinition([definition], run), definition);
  const saved = { commitMessage: "commit", title: "title", body: "body" };
  const draft = { ...saved, saved, runId: "run", gateRevision: 3, gateHash: "gate-hash" };
  assert.strictEqual(appliedDraftFor(draft, run), draft);
  assert.isNull(appliedDraftFor({ ...draft, gateRevision: 4 }, run));
  const feedback = { runId: "run", gateHash: "gate-hash", text: "change it" };
  assert.strictEqual(appliedFeedbackFor(feedback, run), feedback);
  assert.isNull(appliedFeedbackFor({ ...feedback, gateHash: "moved" }, run));
  assert.deepEqual(metadataFrom(artifact("metadata", "metadata", saved)), saved);
  assert.isTrue(sameMetadata(saved, { ...saved }));
});
