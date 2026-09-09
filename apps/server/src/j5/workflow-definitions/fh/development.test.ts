// @effect-diagnostics nodeBuiltinImport:off schemaSyncInEffect:off - fixture callbacks validate known scripted artifacts synchronously.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import * as Handoff from "@j5/workflow-contracts/fh";
import type { Action, Artifact, Run } from "@j5/workflow-contracts";
import { development, latest, selectAgentEvidence } from "./development.ts";
import { git, candidate, publicationBaseBranch, resolveBase } from "./GitWorkspace.ts";
import { commit, push, draft, type GitHub } from "./Publication.ts";
import { makeCodeAdapters } from "./CodeAdapters.ts";
import { makeStore } from "../../workflow/Store.ts";
import { makeWorker, type Adapter } from "../../workflow/Worker.ts";
import { runWorkflowMigrations } from "../../workflow/Migrations.ts";

const decodePublication = Schema.decodeUnknownSync(Handoff.Publication);
const decodeReview = Schema.decodeUnknownSync(Handoff.ReviewHandoff);
const decodeValidation = Schema.decodeUnknownSync(Handoff.Validation);
const decodeWorkspace = Schema.decodeUnknownSync(Handoff.Workspace);

const workflowPhase = (id: string) => development.phases.find((phase) => phase.id === id)!;
const reviewArtifact = (
  id: string,
  verdict: "accept" | "revise",
  blocking: boolean,
  nonBlocking = false,
): Artifact => ({
  id,
  phase: "plan_review",
  content: {
    verdict,
    subjectHash: "plan-hash",
    findings: blocking
      ? [{ blocking: true, description: "Blocking finding" }]
      : nonBlocking
        ? [{ blocking: false, description: "Human may prefer another label" }]
        : [],
  },
  revision: 1,
  producer: id,
  attempt: 1,
  hash: id,
  governs: [],
});
const testRun = (visits: Run["visits"] = {}): Run => ({
  id: "definition-test",
  definitionId: development.id,
  definitionVersion: development.version,
  definitionHash: development.hash,
  squadronId: "s",
  projectId: "p",
  repository: "/repo",
  baseCommit: "base",
  inputs: { request: "change", baseRef: "main", evidence: [] },
  execution: {},
  phase: "plan_review",
  revision: 1,
  status: "running",
  cause: null,
  recovery: null,
  gate: null,
  actions: [],
  artifacts: [
    {
      id: "plan",
      phase: "plan",
      content: { summary: "Plan", steps: ["Change code"], checks: [], assumptions: [] },
      revision: 1,
      producer: "navigator",
      attempt: 1,
      hash: "plan-hash",
      governs: [],
    },
    {
      id: "validation",
      phase: "validation",
      content: {
        codeIdentity: "code-identity",
        tree: "tree",
        passed: true,
        checks: [],
      },
      revision: 1,
      producer: "validation",
      attempt: 1,
      hash: "validation-hash",
      governs: [],
    },
  ],
  approvals: [],
  visits,
});
const reviewerAction = (task: "advocate" | "skeptic" | "critic" | "sentry"): Action => ({
  id: task,
  runId: "definition-test",
  phase: task === "advocate" || task === "skeptic" ? "plan_review" : "code_review",
  revision: 1,
  task,
  attempt: 1,
  kind: "agent",
  adapter: "persona",
  status: "completed",
  deadline: 1,
  input: {},
  resultArtifactId: null,
});
const reviewerTasks = ["advocate", "skeptic", "critic", "sentry"] as const;

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j5-publication-"));
  const repository = NodePath.join(root, "repo");
  const remote = NodePath.join(root, "remote.git");
  await git(root, ["init", "-b", "main", repository]);
  await git(root, ["init", "--bare", remote]);
  await git(repository, ["config", "user.name", "Workflow Fixture"]);
  await git(repository, ["config", "user.email", "workflow@example.test"]);
  await NodeFSP.writeFile(NodePath.join(repository, "README.md"), "Fixture\n");
  await git(repository, ["add", "README.md"]);
  await git(repository, ["commit", "-m", "fixture"]);
  await git(repository, ["remote", "add", "origin", remote]);
  const baseCommit = await git(repository, ["rev-parse", "HEAD"]);
  return { root, repository, baseCommit, remote };
}

it.effect(
  "runs the development sequence through failed-check repair, restart, both gates and one draft",
  () =>
    Effect.gen(function* () {
      const f = yield* Effect.promise(fixture);
      yield* runWorkflowMigrations();
      const store = yield* makeStore;
      const initial: Run = {
        id: "fh-fixture",
        definitionId: development.id,
        definitionVersion: development.version,
        definitionHash: development.hash,
        squadronId: "s",
        projectId: "p",
        repository: f.repository,
        baseCommit: f.baseCommit,
        inputs: { request: "Add a correct value", baseRef: "main", evidence: [] },
        execution: {},
        phase: "workspace",
        revision: 0,
        status: "running",
        cause: null,
        recovery: null,
        gate: null,
        actions: [],
        artifacts: [],
        approvals: [],
        visits: {},
      };
      yield* store.command(
        {
          commandId: "start",
          runId: initial.id,
          initial,
          event: { type: "enter" },
          expectedRevision: 0,
          now: 0,
        },
        development,
      );
      let builds = 0;
      let creates = 0;
      let pr: Awaited<ReturnType<GitHub["find"]>> = null;
      const api: GitHub = {
        find: async () => pr,
        create: async (metadata) => {
          creates++;
          pr = {
            url: "https://example.test/pr/1",
            number: 1,
            draft: true,
            merged: false,
            commit: await git(f.repository, ["rev-parse", metadata.headBranch]),
          };
        },
      };
      const persona: Adapter = {
        recovery: "reconcile",
        interrupt: () => Effect.void,
        reconcile: (action, run) =>
          Effect.promise(async () => {
            let output: unknown;
            if (action.task === "scout")
              output = { summary: "fixture", evidence: ["README.md"], unknowns: [] };
            else if (action.task === "navigator")
              output = {
                summary: "Add value",
                steps: ["Write value.txt"],
                checks: [
                  {
                    executable: "node",
                    args: [
                      "-e",
                      "if(require('fs').readFileSync('value.txt','utf8')!=='correct')process.exit(1)",
                    ],
                  },
                ],
                assumptions: [],
              };
            else if (action.task === "builder") {
              builds++;
              const ws = decodeWorkspace(latest(run, "workspace").content);
              await NodeFSP.writeFile(
                NodePath.join(ws.worktree, "value.txt"),
                builds === 1 ? "incorrect" : "correct",
              );
              output = { summary: "Add verified value", changes: ["value.txt"] };
            } else if (action.phase === "plan_review")
              output = {
                verdict: "revise",
                findings: [{ blocking: true, description: "Prefer a different product choice" }],
                subjectHash: latest(run, "plan").hash,
              };
            else
              output = {
                verdict: "accept",
                findings: [],
                subjectHash: decodeValidation(latest(run, "validation").content).codeIdentity,
              };
            return { status: "completed" as const, output };
          }),
      };
      const adapters = { ...makeCodeAdapters(f.root, api), persona };
      yield* makeWorker(store, [development], adapters, "worker-1").drain(1);
      let run = yield* store.get(initial.id);
      assert.equal(run.phase, "plan_approval");
      assert.equal(run.status, "waiting_approval");
      assert.equal(run.visits.plan, 3);
      assert.equal(run.visits.plan_review, 3);
      const plan = latest(run, "plan");
      const dissentingReviews = run.artifacts
        .filter(
          (artifact) =>
            artifact.phase === "plan_review" &&
            decodeReview(artifact.content).subjectHash === plan.hash,
        )
        .slice(-2);
      assert.deepEqual(run.gate?.artifactIds, [
        plan.id,
        ...dissentingReviews.map((artifact) => artifact.id),
      ]);
      const approve = (current: Run, commandId: string) =>
        store.command(
          {
            commandId,
            runId: current.id,
            expectedRevision: current.revision,
            now: 2,
            event: {
              type: "decision",
              decision: {
                actor: "fixture-human",
                decision: "approve",
                feedback: "",
                gateRevision: current.gate!.revision,
                artifactHash: current.gate!.artifactHash,
              },
            },
          },
          development,
        );
      yield* approve(run, "plan-approve");
      // Recreate both store and worker: no in-memory execution state is needed.
      const restarted = yield* makeStore;
      yield* makeWorker(restarted, [development], adapters, "worker-2").drain(3);
      run = yield* restarted.get(initial.id);
      assert.equal(run.status, "waiting_approval", run.cause ?? "");
      assert.equal(run.phase, "publication_approval");
      assert.equal(builds, 2);
      assert.equal(creates, 0);
      yield* approve(run, "publish-approve");
      yield* makeWorker(restarted, [development], adapters, "worker-3").drain(4);
      const completed = yield* restarted.get(initial.id);
      assert.equal(completed.status, "completed", completed.cause ?? "");
      assert.equal(creates, 1);
      const ws = decodeWorkspace(latest(completed, "workspace").content);
      const metadata = decodePublication(latest(completed, "metadata").content);
      const committed = yield* Effect.promise(() => commit(ws.worktree, f.baseCommit, metadata));
      yield* Effect.promise(() => push(ws.worktree, f.baseCommit, metadata, committed.commit));
      yield* Effect.promise(() => draft(metadata, committed.commit, api));
      assert.equal(creates, 1);
      assert.equal(
        yield* Effect.promise(() =>
          git(ws.worktree, ["rev-list", "--count", `${f.baseCommit}..HEAD`]),
        ),
        "1",
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(ws.worktree, "unapproved.bin"),
          new Uint8Array([0, 255, 1]),
        ),
      );
      const rejected = yield* Effect.exit(
        Effect.promise(() => commit(ws.worktree, f.baseCommit, metadata)),
      );
      assert.equal(rejected._tag, "Failure");
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.each([
  {
    name: "revises before either plan budget is exhausted",
    visits: { plan: 2, plan_review: 2 },
    expected: "revise",
  },
  {
    name: "escalates when both plan budgets are exhausted",
    visits: { plan: 3, plan_review: 3 },
    expected: "escalate",
  },
  {
    name: "escalates when the review budget is exhausted",
    visits: { plan: 2, plan_review: 3 },
    expected: "escalate",
  },
])("$name", ({ visits, expected }) => {
  const run = testRun(visits);
  assert.equal(
    development.outcome(run, workflowPhase("plan_review"), [
      reviewArtifact("advocate", "revise", true),
      reviewArtifact("skeptic", "revise", true),
    ]),
    expected,
  );
});

it("escalates a split plan review on the final round", () => {
  const run = testRun({ plan: 3, plan_review: 3 });
  assert.equal(
    development.outcome(run, workflowPhase("plan_review"), [
      reviewArtifact("advocate", "accept", false),
      reviewArtifact("skeptic", "revise", true),
    ]),
    "escalate",
  );
});

it.each([
  { name: "before the budget limit", visits: { plan: 2, plan_review: 2 } },
  { name: "at the budget limit", visits: { plan: 3, plan_review: 3 } },
])("passes two accepting plan reviews $name, including non-blocking findings", ({ visits }) => {
  const run = testRun(visits);
  assert.equal(
    development.outcome(run, workflowPhase("plan_review"), [
      reviewArtifact("advocate", "accept", false, true),
      reviewArtifact("skeptic", "accept", false),
    ]),
    "pass",
  );
});

it("revises rejected code reviews regardless of plan counters", () => {
  const run = testRun({ plan: 3, plan_review: 3 });
  assert.equal(
    development.outcome(run, workflowPhase("code_review"), [
      reviewArtifact("critic", "revise", true),
      reviewArtifact("sentry", "revise", true),
    ]),
    "revise",
  );
});

it.each(reviewerTasks)("rejects %s accepting a blocking finding", (task) => {
  const run = testRun();
  const subjectHash = task === "advocate" || task === "skeptic" ? "plan-hash" : "code-identity";
  assert.throws(
    () =>
      development.validate(
        reviewerAction(task),
        {
          verdict: "accept",
          subjectHash,
          findings: [{ blocking: true, description: "Blocking finding" }],
        },
        run,
      ),
    /verdict must match/,
  );
});

it.each(reviewerTasks)("rejects %s revising without a blocking finding", (task) => {
  const run = testRun();
  const subjectHash = task === "advocate" || task === "skeptic" ? "plan-hash" : "code-identity";
  assert.throws(
    () =>
      development.validate(
        reviewerAction(task),
        {
          verdict: "revise",
          subjectHash,
          findings: [{ blocking: false, description: "Preference" }],
        },
        run,
      ),
    /verdict must match/,
  );
});

it.each(reviewerTasks)("accepts %s revising with a blocking finding", (task) => {
  const run = testRun();
  const subjectHash = task === "advocate" || task === "skeptic" ? "plan-hash" : "code-identity";
  assert.doesNotThrow(() =>
    development.validate(
      reviewerAction(task),
      {
        verdict: "revise",
        subjectHash,
        findings: [{ blocking: true, description: "Blocking finding" }],
      },
      run,
    ),
  );
});

it.each(reviewerTasks)("accepts %s accepting empty or non-blocking findings", (task) => {
  const run = testRun();
  const subjectHash = task === "advocate" || task === "skeptic" ? "plan-hash" : "code-identity";
  for (const findings of [[], [{ blocking: false, description: "Preference" }]]) {
    assert.doesNotThrow(() =>
      development.validate(reviewerAction(task), { verdict: "accept", subjectHash, findings }, run),
    );
  }
});

it("requires plans to record assumptions, including an empty list", () => {
  const decodePlan = Schema.decodeUnknownSync(Handoff.PlanHandoff);
  const plan = {
    summary: "Plan",
    steps: ["Change code"],
    checks: [{ executable: "vp", args: ["test"] }],
  };
  assert.doesNotThrow(() => decodePlan({ ...plan, assumptions: [] }));
  assert.throws(() => decodePlan(plan));
});

it("includes untracked binary bytes and file modes in code identity without changing the real index", async () => {
  const f = await fixture();
  const before = await candidate(f.repository, f.baseCommit);
  await NodeFSP.writeFile(NodePath.join(f.repository, "binary"), new Uint8Array([0, 255]));
  const added = await candidate(f.repository, f.baseCommit);
  assert.notEqual(added.codeIdentity, before.codeIdentity);
  await NodeFSP.chmod(NodePath.join(f.repository, "binary"), 0o755);
  assert.notEqual((await candidate(f.repository, f.baseCommit)).codeIdentity, added.codeIdentity);
  assert.equal(await git(f.repository, ["diff", "--cached", "--name-only"]), "");
});

it("resolves HEAD while preserving its tracked branch as the publication target", async () => {
  const f = await fixture();
  await git(f.repository, ["push", "-u", "origin", "main"]);
  assert.equal(await resolveBase(f.repository, " HEAD "), f.baseCommit);
  assert.equal(await publicationBaseBranch(f.repository, "HEAD"), "main");
});

it("reports an actionable error when the base ref is unavailable", async () => {
  const f = await fixture();
  assert.equal(
    await resolveBase(f.repository, "   ").catch(String),
    "Error: Enter a base ref before starting the workflow",
  );
  const error = await resolveBase(f.repository, "main-does-not-exist").catch(String);
  assert.match(error, /Base ref "main-does-not-exist" does not resolve to a commit/);
});

it("selects revision-related evidence and excludes superseded reviews", () => {
  const artifact = (id: string, phase: string, content: unknown, revision: number) => ({
    id,
    phase,
    content,
    revision,
    producer: phase,
    attempt: 1,
    hash: id,
    governs: [],
  });
  const run: Run = {
    id: "selection",
    definitionId: development.id,
    definitionVersion: development.version,
    definitionHash: development.hash,
    squadronId: "s",
    projectId: "p",
    repository: "/repo",
    baseCommit: "base",
    inputs: { request: "change", baseRef: "main", evidence: ["ticket:1"] },
    execution: {},
    phase: "plan_review",
    revision: 12,
    status: "running",
    cause: null,
    recovery: null,
    gate: null,
    actions: [],
    artifacts: [
      artifact(
        "workspace",
        "workspace",
        { worktree: "/work", branch: "change", baseCommit: "base" },
        1,
      ),
      artifact("context", "scout", { summary: "context" }, 2),
      artifact("plan-old", "plan", { summary: "old" }, 3),
      artifact(
        "old-review",
        "plan_review",
        { verdict: "revise", subjectHash: "plan-old", findings: [] },
        4,
      ),
      artifact("plan-current", "plan", { summary: "current" }, 6),
      artifact(
        "current-review",
        "plan_review",
        { verdict: "accept", subjectHash: "plan-current", findings: [] },
        7,
      ),
      artifact("build-old", "build", { summary: "old build" }, 8),
      artifact(
        "validation",
        "validation",
        { codeIdentity: "candidate", tree: "tree", passed: true, checks: [] },
        9,
      ),
      artifact(
        "unrelated-code-review",
        "code_review",
        { verdict: "accept", subjectHash: "other", findings: [] },
        10,
      ),
      artifact(
        "matching-code-review",
        "code_review",
        { verdict: "accept", subjectHash: "candidate", findings: [] },
        11,
      ),
    ],
    approvals: [
      {
        phase: "plan_approval",
        gateRevision: 5,
        artifactHash: "gate-1",
        decision: "request_changes",
        feedback: "first",
        actor: "human",
      },
      {
        phase: "plan_approval",
        gateRevision: 8,
        artifactHash: "gate-2",
        decision: "request_changes",
        feedback: "second",
        actor: "human",
      },
      {
        phase: "plan_approval",
        gateRevision: 10,
        artifactHash: "gate-3",
        decision: "approve",
        feedback: "",
        actor: "human",
      },
      {
        phase: "publication_approval",
        gateRevision: 12,
        artifactHash: "gate-4",
        decision: "request_changes",
        feedback: "adjust publication",
        actor: "human",
      },
    ],
    visits: {},
  };

  const navigator = selectAgentEvidence(run, "navigator");
  assert.deepEqual(
    navigator.artifacts.map(({ id }) => id),
    ["workspace", "context", "plan-current", "current-review"],
  );
  assert.deepEqual(
    navigator.decisions.map(({ feedback }) => feedback),
    ["first", "second"],
  );

  const builder = selectAgentEvidence(run, "builder");
  assert.includeMembers(
    builder.artifacts.map(({ id }) => id),
    ["plan-current", "build-old", "validation", "matching-code-review"],
  );
  assert.notInclude(
    builder.artifacts.map(({ id }) => id),
    "unrelated-code-review",
  );
  assert.deepEqual(
    builder.decisions.map(({ feedback }) => feedback),
    ["", "adjust publication"],
  );

  const critic = selectAgentEvidence(run, "critic");
  assert.deepEqual(
    critic.decisions.map(({ feedback }) => feedback),
    ["adjust publication"],
  );
});
