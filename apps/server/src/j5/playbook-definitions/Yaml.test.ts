// @effect-diagnostics nodeBuiltinImport:off - fixture lives beside the test.
import type { Action, Decision, Run } from "@j5/playbook-contracts";
import { assert, it } from "@effect/vitest";
import * as NodeFS from "node:fs";

import { parse, stringify } from "yaml";
import { compileYamlPlaybook } from "./Yaml.ts";
import { development } from "./fh/development.ts";
import { hash } from "../playbook/Definition.ts";
import { testExecution } from "../playbook/testFixtures.ts";
import { decide } from "../playbook/decider.ts";

const source = NodeFS.readFileSync(new URL("./research-review.yaml", import.meta.url), "utf8");

it("binds both reviewers, corrected attempts, and only the latest review round into feedback and gates", () => {
  const definition = compileYamlPlaybook(
    source
      .replace("approvals: [approval]", "approvals: [approval]\n    evidence: [review]")
      .replace(
        "    outcome: review",
        "      - id: second-review\n        persona: sentry\n        authority: critic-review\n        instructions: Review the research.\n        output: review\n    outcome: review",
      ),
  );
  let run: Run = {
    id: "paired-review",
    definitionId: definition.id,
    definitionVersion: definition.version,
    definitionHash: definition.hash,
    squadronId: "squadron",
    projectId: "project",
    repository: "/test",
    baseCommit: "main",
    inputs: { request: "research" },
    execution: {
      ...testExecution,
      personas: {
        researcher: testExecution.personas.scout,
        "inline:review:review-report": testExecution.personas.critic,
        "inline:review:second-review": {
          ...testExecution.personas.sentry,
          authorityPolicy: "critic-review",
        },
      },
    },
    phase: definition.initial,
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
  const complete = (output: unknown) => {
    const action = run.actions.findLast((item) => item.status === "pending")!;
    run = decide(run, { type: "result", actionId: action.id, output }, definition, 0);
  };
  const report = () =>
    complete({
      summary: `Round ${run.visits.research}`,
      body: "evidence",
      evidence: [],
      unknowns: [],
    });
  const review = (verdict: "accept" | "revise") =>
    complete({
      verdict,
      subjectHash: run.artifacts.findLast((item) => item.phase === "research")!.hash,
      findings: verdict === "revise" ? [{ blocking: true, description: "Missing evidence" }] : [],
    });
  run = decide(run, { type: "enter" }, definition, 0);
  complete({ worktree: "/test", branch: "branch" });
  report();
  review("revise");
  complete("invalid output");
  review("accept");
  assert.equal(run.phase, "research");
  const action = run.actions.findLast((item) => item.status === "pending")!;
  const selected = (action.input as { selectedEvidenceIds: string[] }).selectedEvidenceIds;
  assert.lengthOf(selected, 2);
  assert.include((action.input as { prompt: string }).prompt, "Missing evidence");
  assert.isTrue(run.artifacts.some((item) => selected.includes(item.id) && item.attempt === 2));
  report();
  review("accept");
  review("accept");
  assert.equal(run.phase, "approval");
  assert.lengthOf(run.gate!.artifactIds, 3);
  assert.isFalse(run.gate!.artifactIds.some((id) => selected.includes(id)));
});

it("compiles ordered phases and explicit shared agents", () => {
  const definition = compileYamlPlaybook(source, "research-review.yaml");
  assert.equal(definition.id, "research-review");
  assert.deepEqual(
    definition.phases.map((phase) => phase.id),
    ["__workspace", "research", "review", "approval"],
  );
  assert.equal(definition.phases[1]!.tasks[0]!.agent, "researcher");
  assert.equal(definition.phases[2]!.tasks[0]!.agent, undefined);
  assert.equal(definition.agents?.researcher?.persona, "scout");
  assert.equal(definition.agents?.["inline:review:review-report"]?.persona, "critic");
});

it("binds named gate feedback into a later shared-agent turn", () => {
  const definition = compileYamlPlaybook(source, "research-review.yaml");
  const decision = {
    gateRevision: 4,
    artifactHash: "gate-hash",
    decision: "request_changes",
    feedback: "Mention that the project is open source.",
    actor: "reviewer",
    phase: "approval",
  } satisfies Decision;
  const run = {
    id: "run",
    definitionId: definition.id,
    definitionVersion: definition.version,
    definitionHash: definition.hash,
    squadronId: "squadron",
    projectId: "project",
    repository: "/test",
    baseCommit: "main",
    inputs: { request: "Summarize the README" },
    execution: {
      ...testExecution,
      personas: { ...testExecution.personas, researcher: testExecution.personas.scout },
    },
    phase: "research",
    revision: 5,
    status: "running",
    cause: null,
    recovery: null,
    gate: null,
    actions: [],
    artifacts: [],
    approvals: [decision],
    visits: { research: 2 },
  } satisfies Run;
  const phase = definition.phases.find((item) => item.id === "research")!;
  const input = definition.input(run, phase, phase.tasks[0]!) as {
    prompt: string;
    selectedEvidenceHashes: readonly string[];
  };

  assert.include(input.prompt, decision.feedback);
  assert.deepEqual(input.selectedEvidenceHashes, [hash(decision)]);
});

it("loads Development YAML through its pinned compatibility implementation", () => {
  const yaml = NodeFS.readFileSync(new URL("./fh/development.yaml", import.meta.url), "utf8");
  const compiled = compileYamlPlaybook(yaml, "development.yaml", {
    "fh-development-v3": development,
  });
  assert.equal(compiled.hash, development.hash);
  assert.deepEqual(
    compiled.phases.map((phase) => phase.id),
    development.phases.map((phase) => phase.id),
  );
});

it("reports source files and fields for invalid references", () => {
  assert.throws(
    () => compileYamlPlaybook(source.replace("agent: researcher", "agent: missing"), "team.yaml"),
    /team\.yaml:phases\.research\.tasks\.investigate\.agent: unknown agent missing/,
  );
  assert.throws(
    () =>
      compileYamlPlaybook(source.replace("completed: review", "completed: nowhere"), "team.yaml"),
    /team\.yaml:phases\.research\.transitions\.completed: unknown phase nowhere/,
  );
  assert.throws(
    () =>
      compileYamlPlaybook(
        source.replace("evidence: [research]", "evidence: [missing]"),
        "team.yaml",
      ),
    /team\.yaml:phases\.review\.evidence: unknown evidence phase missing/,
  );
  assert.throws(
    () =>
      compileYamlPlaybook(
        source.replace("approvals: [approval]", "approvals: [missing]"),
        "team.yaml",
      ),
    /team\.yaml:phases\.research\.approvals: unknown approval gate missing/,
  );
});

it("rejects generic outcomes that the selected aggregation cannot produce", () => {
  assert.throws(
    () => compileYamlPlaybook(source.replace("completed: review", "pass: review"), "team.yaml"),
    /team\.yaml:phases\.research\.transitions\.pass: outcome pass is not valid/,
  );
  assert.throws(
    () =>
      compileYamlPlaybook(
        source
          .replace("outcome: review", "outcome: validation")
          .replace("      revise: research\n", ""),
        "team.yaml",
      ),
    /team\.yaml:phases\.review\.outcome: validation aggregation requires validation as the first code task/,
  );
  assert.throws(
    () =>
      compileYamlPlaybook(
        source.replace(
          "    label: Report approval\n    kind: gate",
          "    label: Report approval\n    kind: gate\n    outcome: completion",
        ),
        "team.yaml",
      ),
    /team\.yaml:phases\.approval\.outcome: gates cannot declare outcome aggregation/,
  );
  assert.throws(
    () =>
      compileYamlPlaybook(source.replace("outcome: completion", "outcome: review"), "team.yaml"),
    /team\.yaml:phases\.research\.outcome: review aggregation requires agent tasks with review output/,
  );
});

it("accepts bounded generic graphs and supported optional bindings", () => {
  const laterEvidence = compileYamlPlaybook(
    source.replace(
      "approvals: [approval]",
      "evidence: [review, __workspace]\n    approvals: [approval]",
    ),
    "later.yaml",
  );
  assert.equal(laterEvidence.phases[1]!.maxVisits, 3);
  const evidence = [
    {
      id: "workspace",
      hash: "workspace-hash",
      content: { worktree: "/test", branch: "branch" },
      producer: "workspace",
      phase: "__workspace",
      revision: 1,
      attempt: 1,
      governs: [],
    },
    {
      id: "later",
      hash: "later-hash",
      content: { summary: "later" },
      producer: "review",
      phase: "review",
      revision: 2,
      attempt: 1,
      governs: [],
    },
  ] satisfies Run["artifacts"];
  const boundInput = laterEvidence.input(
    {
      id: "bindings",
      definitionId: laterEvidence.id,
      definitionVersion: laterEvidence.version,
      definitionHash: laterEvidence.hash,
      squadronId: "squadron",
      projectId: "project",
      repository: "/test",
      baseCommit: "main",
      inputs: { request: "test" },
      execution: {
        ...testExecution,
        personas: { ...testExecution.personas, researcher: testExecution.personas.scout },
      },
      phase: "research",
      revision: 3,
      status: "running",
      cause: null,
      recovery: null,
      gate: null,
      actions: [],
      artifacts: evidence,
      approvals: [],
      visits: { research: 1 },
    },
    laterEvidence.phases[1]!,
    laterEvidence.phases[1]!.tasks[0]!,
  ) as { selectedEvidenceHashes: readonly string[] };
  assert.deepEqual(boundInput.selectedEvidenceHashes, ["later-hash", "workspace-hash"]);

  const multipleTasks = compileYamlPlaybook(
    source.replace(
      "    outcome: completion",
      "      - id: corroborate\n        persona: scout\n        instructions: Corroborate the research.\n        output: report\n    outcome: completion",
    ),
    "multiple.yaml",
  );
  assert.lengthOf(multipleTasks.phases[1]!.tasks, 2);

  assert.doesNotThrow(() =>
    compileYamlPlaybook(source.replace("    outcome: completion\n", ""), "omitted.yaml"),
  );
  assert.doesNotThrow(() =>
    compileYamlPlaybook(
      source.replace(
        "      approve: $complete\n      request_changes: research",
        "      approve: $complete",
      ),
      "subset.yaml",
    ),
  );
  assert.doesNotThrow(() =>
    compileYamlPlaybook(
      source.replace(
        "    transitions:\n      approve: $complete\n      request_changes: research",
        "    transitions: {}",
      ),
      "empty.yaml",
    ),
  );
  assert.doesNotThrow(() =>
    compileYamlPlaybook(
      source.replace("      completed: review", "      completed: review\n      changed: research"),
      "changed.yaml",
    ),
  );
  assert.doesNotThrow(() =>
    compileYamlPlaybook(
      source.replace(
        "      approve: $complete\n      request_changes: research",
        "      approve: $complete\n      request_changes: research\n      changed: research",
      ),
      "gate-changed.yaml",
    ),
  );
});

it("rejects built-in validation operations in custom YAML", () => {
  const withValidation = source
    .replace("initial: research", "initial: verify")
    .replace(
      "phases:\n",
      "phases:\n  - id: verify\n    kind: code\n    tasks:\n      - id: validation\n        operation: validation\n    outcome: validation\n    transitions: { pass: research, revise: research }\n",
    );
  assert.throws(
    () => compileYamlPlaybook(withValidation, "operations.yaml"),
    /operations.yaml:phases.verify.tasks.validation.operation: validation is built-in-only/,
  );
});

it("rejects scheduling the same shared conversation twice in one phase", () => {
  const duplicate = source.replace(
    "    outcome: completion",
    "      - id: investigate-again\n        agent: researcher\n        instructions: Check the research.\n        output: report\n    outcome: completion",
  );
  assert.throws(
    () => compileYamlPlaybook(duplicate, "team.yaml"),
    /Shared agent is scheduled twice/,
  );
});

it("validates corrected reviews against the originally scheduled evidence", () => {
  const definition = compileYamlPlaybook(source, "research-review.yaml");
  const subjectHash = "research-hash";
  const action = {
    id: "review-correction",
    runId: "run",
    phase: "review",
    revision: 3,
    task: "review-report",
    attempt: 2,
    kind: "agent",
    adapter: "persona",
    status: "pending",
    deadline: 1,
    resultArtifactId: null,
    input: {
      original: { selectedEvidenceHashes: [subjectHash] },
      correction: "Return valid JSON",
      output: "invalid",
    },
  } satisfies Action;

  assert.deepEqual(
    definition.validate(action, { verdict: "accept", subjectHash, findings: [] }, {} as Run),
    { verdict: "accept", subjectHash, findings: [] },
  );
});

const publicationSource = NodeFS.readFileSync(
  new URL(
    "../../../../../.agents/skills/j5-new-playbook/examples/publication.yaml",
    import.meta.url,
  ),
  "utf8",
);
it("compiles custom publication phases and rejects incomplete or unsafe sequences", () => {
  const definition = compileYamlPlaybook(publicationSource);
  assert.deepEqual(definition.publication, {
    metadata: "prepare-publication",
    approval: "pr-approval",
    commit: "commit",
    push: "push",
    draft: "create-pr",
  });
  const check = (
    mutate: (source: {
      phases: Array<{
        id: string;
        evidence?: string[];
        tasks?: Array<{ operation?: string }>;
        transitions: Record<string, string>;
      }>;
      initial: string;
    }) => void,
    error: RegExp,
  ) => {
    const source = parse(publicationSource) as {
      phases: Array<{
        id: string;
        evidence?: string[];
        tasks?: Array<{ operation?: string }>;
        transitions: Record<string, string>;
      }>;
      initial: string;
    };
    mutate(source);
    assert.throws(() => compileYamlPlaybook(stringify(source), "bug.yaml"), error);
  };
  check((source) => {
    source.phases = source.phases.filter(
      (phase: { id: string }) => phase.id !== "prepare-publication",
    );
    source.phases[2]!.transitions.completed = "pr-approval";
    source.phases[3]!.evidence!.pop();
  }, /bug.yaml:phases: publication requires exactly one preparation step/);
  check((source) => {
    source.phases[4]!.evidence!.pop();
  }, /include preparation phase/);
  check((source) => {
    source.phases[2]!.transitions.completed = "commit";
  }, /cannot bypass publication/);
  check((source) => {
    source.phases[4]!.transitions.request_changes = "commit";
  }, /cannot bypass publication/);
  check((source) => {
    source.phases[5]!.transitions.pass = "create-pr";
  }, /publication order requires push/);
  check((source) => {
    source.phases[3]!.tasks![0]!.operation = "validation";
  }, /built-in-only/);
  check((source) => {
    source.phases[3]!.tasks![0]!.operation = "repair_capacity";
  }, /built-in-only/);
  check((source) => {
    source.phases[3]!.evidence = ["scout", "development"];
  }, /select exactly one developer report/);
  check((source) => {
    source.phases.push({ ...structuredClone(source.phases[3]!), id: "second-preparation" });
  }, /exactly one preparation step/);
  assert.throws(
    () =>
      compileYamlPlaybook(
        publicationSource.replace(
          "label: Prepare publication",
          "label: Prepare publication\n    capabilities: [publication]",
        ),
      ),
    /capabilities: publication and candidate-watch require/,
  );
  check((source) => {
    source.initial = "prepare-publication";
  }, /developer report must run before preparation/);
});

it("requires publication before read-only feedback collection", () => {
  const authored = parse(publicationSource) as import("./Yaml.ts").YamlPlaybook;
  assert.throws(
    () =>
      compileYamlPlaybook(
        stringify({
          ...authored,
          initial: "feedback",
          phases: [
            {
              id: "feedback",
              kind: "code",
              tasks: [{ id: "collect", operation: "feedback" }],
              transitions: { pass: authored.initial },
            },
            ...authored.phases,
          ],
        }),
      ),
    /draft publication must run before feedback on every path/,
  );
});
