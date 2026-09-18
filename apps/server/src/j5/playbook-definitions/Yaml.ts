import * as Handoff from "@j5/playbook-contracts/fh";
import type { Action, Artifact, Run, PublicationPhases } from "@j5/playbook-contracts";
import {
  AgentPersonaAuthorityPolicy,
  type AgentPersonaAuthorityPolicy as Authority,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { parseDocument, stringify } from "yaml";

import {
  canonical,
  hash,
  selectedEvidenceHashes,
  validateDefinition,
  type Definition,
  type Phase,
} from "../playbook/Definition.ts";
import { readPlaybookExecution } from "../playbook/Execution.ts";
import { runtimeBuildHash } from "./manifest.ts";

const NonEmpty = Schema.String.check(Schema.isMinLength(1));
const Agent = Schema.Struct({ persona: NonEmpty, authority: AgentPersonaAuthorityPolicy });
const Task = Schema.Struct({
  id: NonEmpty,
  agent: Schema.optional(NonEmpty),
  persona: Schema.optional(NonEmpty),
  authority: Schema.optional(AgentPersonaAuthorityPolicy),
  operation: Schema.optional(
    Schema.Literals([
      "workspace",
      "validation",
      "repair_capacity",
      "metadata",
      "commit",
      "push",
      "draft",
      "feedback",
    ]),
  ),
  instructions: Schema.optional(NonEmpty),
  output: Schema.optional(Schema.Literals(["report", "review"])),
});
const PhaseSource = Schema.Struct({
  id: NonEmpty,
  label: Schema.optional(NonEmpty),
  kind: Schema.Literals(["agent", "code", "gate"]),
  tasks: Schema.optional(Schema.Array(Task)),
  visitLimit: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  outcome: Schema.optional(Schema.Literals(["completion", "review", "validation"])),
  transitions: Schema.Record(NonEmpty, NonEmpty),
  evidence: Schema.optional(Schema.Array(NonEmpty)),
  approvals: Schema.optional(Schema.Array(NonEmpty)),
  capabilities: Schema.optional(Schema.Array(NonEmpty)),
});
export const YamlPlaybook = Schema.Struct({
  schema: Schema.Literal("t3-playbook/v1"),
  id: NonEmpty,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  name: NonEmpty,
  description: NonEmpty,
  implementation: Schema.optional(NonEmpty),
  initial: NonEmpty,
  agents: Schema.optional(Schema.Record(NonEmpty, Agent)),
  phases: Schema.Array(PhaseSource),
});
export type YamlPlaybook = typeof YamlPlaybook.Type;
const decodeYamlPlaybook = Schema.decodeUnknownSync(YamlPlaybook);

export class PlaybookDefinitionSourceError extends Error {
  readonly file: string;
  readonly field: string;
  constructor(file: string, field: string, message: string) {
    super(`${file}:${field}: ${message}`);
    this.file = file;
    this.field = field;
  }
}

const report = Schema.Struct({
  summary: NonEmpty,
  body: Schema.String,
  evidence: Schema.Array(Schema.String),
  unknowns: Schema.Array(Schema.String),
});
const review = Schema.Struct({
  verdict: Schema.Literals(["accept", "revise"]),
  subjectHash: NonEmpty,
  findings: Schema.Array(Schema.Struct({ blocking: Schema.Boolean, description: NonEmpty })),
});
const decodeReport = Schema.decodeUnknownSync(report);
const decodeReview = Schema.decodeUnknownSync(review);
const decodePublicationMetadata = Schema.decodeUnknownSync(Handoff.PublicationMetadata);
const decodeMetadataFields = Schema.decodeUnknownSync(
  Schema.Struct({ commitMessage: NonEmpty, title: NonEmpty, body: Schema.String }),
);
const codeOutput = {
  metadata: decodePublicationMetadata,
  commit: Schema.decodeUnknownSync(Handoff.CommitResult),
  push: Schema.decodeUnknownSync(Handoff.PushResult),
  draft: Schema.decodeUnknownSync(Handoff.PullRequestResult),
  feedback: Schema.decodeUnknownSync(Handoff.PullRequestFeedback),
};
const outputInstruction = {
  report:
    'Return ONLY one JSON object with {"summary":string,"body":string,"evidence":string[],"unknowns":string[]}.',
  review:
    'Return ONLY one JSON object with {"verdict":"accept"|"revise","subjectHash":string,"findings":{"blocking":boolean,"description":string}[]}.',
} as const;

function sourceValue(text: string, file: string): unknown {
  try {
    const document = parseDocument(text, { version: "1.2", uniqueKeys: true });
    const issue = document.errors[0] ?? document.warnings[0];
    if (issue) throw issue;
    return document.toJS({ maxAliasCount: 0 });
  } catch (cause) {
    throw new PlaybookDefinitionSourceError(
      file,
      "$",
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}

const latest = (run: Run, phase: string) =>
  run.artifacts.findLast((artifact) => artifact.phase === phase);

/** Publishing is one contiguous sequence; every incoming edge must preserve its order. */
function publicationPhases(source: YamlPlaybook, file: string): PublicationPhases | undefined {
  const fail = (field: string, message: string): never => {
    throw new PlaybookDefinitionSourceError(file, field, message);
  };
  for (const phase of source.phases)
    for (const task of phase.tasks ?? [])
      if (["workspace", "validation", "repair_capacity"].includes(task.operation ?? ""))
        fail(
          `phases.${phase.id}.tasks.${task.id}.operation`,
          `${task.operation} is built-in-only; custom playbooks use __workspace and developer reports`,
        );
  const operations = ["metadata", "commit", "push", "draft"] as const;
  if (
    !source.phases.some((phase) =>
      phase.tasks?.some((task) => operations.some((op) => op === task.operation)),
    )
  )
    return undefined;
  const selected = operations.map((operation) => {
    const matches = source.phases.filter((phase) =>
      phase.tasks?.some((task) => task.operation === operation),
    );
    if (matches.length !== 1)
      fail(
        "phases",
        `publication requires exactly one ${operation === "metadata" ? "preparation step (operation: metadata)" : `${operation} step`}`,
      );
    const phase = matches[0]!;
    if (phase.kind !== "code" || phase.tasks?.length !== 1)
      fail(`phases.${phase.id}.tasks`, `${operation} requires its own code phase with one task`);
    return phase;
  });
  const [metadata, commit, push, draft] = selected as [
    (typeof source.phases)[number],
    (typeof source.phases)[number],
    (typeof source.phases)[number],
    (typeof source.phases)[number],
  ];
  const approval = source.phases.find((phase) => phase.id === metadata.transitions.pass);
  if (!approval || approval.kind !== "gate")
    fail(
      `phases.${metadata.id}.transitions.pass`,
      "preparation must lead directly to a publication approval gate",
    );
  const gate = approval!;
  if (!gate.evidence?.includes(metadata.id))
    fail(
      `phases.${gate.id}.evidence`,
      `include preparation phase ${metadata.id} in approval evidence`,
    );
  const reports = (metadata.evidence ?? []).map((id) =>
    source.phases.find((phase) => phase.id === id),
  );
  if (
    reports.length !== 1 ||
    reports[0]?.kind !== "agent" ||
    reports[0]?.tasks?.length !== 1 ||
    reports[0]?.tasks?.[0]?.output !== "report"
  )
    fail(
      `phases.${metadata.id}.evidence`,
      "select exactly one developer report phase with one report task",
    );
  const chain = [metadata, gate, commit, push, draft];
  for (let index = 1; index < chain.length; index++) {
    const previous = chain[index - 1]!;
    const phase = chain[index]!;
    const outcome = previous.kind === "gate" ? "approve" : "pass";
    if (previous.transitions[outcome] !== phase.id)
      fail(
        `phases.${previous.id}.transitions.${outcome}`,
        `publication order requires ${phase.id}`,
      );
    if (source.initial === phase.id)
      fail("initial", `publication cannot start at ${phase.id}; run preparation first`);
    for (const incoming of source.phases)
      for (const [edge, target] of Object.entries(incoming.transitions))
        if (target === phase.id && (incoming.id !== previous.id || edge !== outcome))
          fail(
            `phases.${incoming.id}.transitions.${edge}`,
            `cannot bypass publication preparation/approval/order to enter ${phase.id}`,
          );
  }
  // A report must exist on every path to preparation, including the first visit.
  const pending = [source.initial];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === reports[0]!.id || id === "$complete" || visited.has(id)) continue;
    if (id === metadata.id)
      fail(
        `phases.${metadata.id}.evidence`,
        "developer report must run before preparation on every path",
      );
    visited.add(id);
    const phase = source.phases.find((item) => item.id === id);
    pending.push(...Object.values(phase?.transitions ?? {}));
  }
  return {
    metadata: metadata.id,
    approval: gate.id,
    commit: commit.id,
    push: push.id,
    draft: draft.id,
  };
}

/** Compile the deliberately small v1 authoring language into the existing pure engine. */
export function compileYamlPlaybook(
  text: string,
  file = "playbook.yaml",
  implementations: Readonly<Record<string, Definition>> = {},
): Definition {
  let source: YamlPlaybook;
  try {
    source = decodeYamlPlaybook(sourceValue(text, file));
  } catch (cause) {
    if (cause instanceof PlaybookDefinitionSourceError) throw cause;
    throw new PlaybookDefinitionSourceError(
      file,
      "$",
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (source.phases.length === 0)
    throw new PlaybookDefinitionSourceError(file, "phases", "at least one phase is required");
  if (source.implementation) {
    const registered = implementations[source.implementation];
    if (!registered)
      throw new PlaybookDefinitionSourceError(
        file,
        "implementation",
        `unsupported implementation ${source.implementation}`,
      );
    if (registered.id !== source.id || registered.version !== source.version)
      throw new PlaybookDefinitionSourceError(
        file,
        "implementation",
        "registered implementation identity does not match the YAML definition",
      );
    return {
      ...registered,
      title: source.name,
      description: source.description,
      source: stringify(source, { sortMapEntries: true, lineWidth: 0 }),
      runtime: `${source.implementation}:${runtimeBuildHash}`,
      phases: registered.phases.map((phase) => {
        const label = source.phases.find((item) => item.id === phase.id)?.label;
        return { ...phase, ...(label === undefined ? {} : { label }) };
      }),
    };
  }
  const phaseIds = new Set(source.phases.map((phase) => phase.id));
  const gateIds = new Set(
    source.phases.filter((phase) => phase.kind === "gate").map((phase) => phase.id),
  );
  for (const phase of source.phases) {
    for (const evidence of phase.evidence ?? [])
      if (evidence !== "__workspace" && !phaseIds.has(evidence))
        throw new PlaybookDefinitionSourceError(
          file,
          `phases.${phase.id}.evidence`,
          `unknown evidence phase ${evidence}`,
        );
    for (const approval of phase.approvals ?? [])
      if (!gateIds.has(approval))
        throw new PlaybookDefinitionSourceError(
          file,
          `phases.${phase.id}.approvals`,
          `unknown approval gate ${approval}`,
        );
    if (phase.kind === "gate" && phase.outcome !== undefined)
      throw new PlaybookDefinitionSourceError(
        file,
        `phases.${phase.id}.outcome`,
        "gates cannot declare outcome aggregation",
      );
    if (
      phase.outcome === "review" &&
      (phase.kind !== "agent" ||
        !(phase.tasks?.length && phase.tasks.every((task) => task.output === "review")))
    )
      throw new PlaybookDefinitionSourceError(
        file,
        `phases.${phase.id}.outcome`,
        "review aggregation requires agent tasks with review output",
      );
    if (
      phase.outcome === "validation" &&
      (phase.kind !== "code" || phase.tasks?.[0]?.operation !== "validation")
    )
      throw new PlaybookDefinitionSourceError(
        file,
        `phases.${phase.id}.outcome`,
        "validation aggregation requires validation as the first code task",
      );
    const allowed =
      phase.kind === "gate"
        ? ["approve", "request_changes"]
        : phase.kind === "agent"
          ? phase.outcome === "review"
            ? ["completed", "revise"]
            : ["completed"]
          : phase.outcome === "validation"
            ? ["pass", "revise"]
            : ["pass"];
    for (const outcome of Object.keys(phase.transitions))
      if (outcome !== "changed" && !allowed.includes(outcome))
        throw new PlaybookDefinitionSourceError(
          file,
          `phases.${phase.id}.transitions.${outcome}`,
          `outcome ${outcome} is not valid for this ${phase.kind} phase`,
        );
    for (const [outcome, target] of Object.entries(phase.transitions))
      if (target !== "$complete" && !phaseIds.has(target))
        throw new PlaybookDefinitionSourceError(
          file,
          `phases.${phase.id}.transitions.${outcome}`,
          `unknown phase ${target}`,
        );
  }
  const publication = publicationPhases(source, file);
  for (const feedback of source.phases.filter((phase) =>
    phase.tasks?.some((task) => task.operation === "feedback"),
  )) {
    if (!publication)
      throw new PlaybookDefinitionSourceError(
        file,
        `phases.${feedback.id}.tasks`,
        "feedback requires a publication sequence",
      );
    const pending = [source.initial];
    const visited = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (id === publication.draft || visited.has(id)) continue;
      if (id === feedback.id)
        throw new PlaybookDefinitionSourceError(
          file,
          `phases.${feedback.id}.tasks`,
          "draft publication must run before feedback on every path",
        );
      visited.add(id);
      pending.push(
        ...Object.values(source.phases.find((phase) => phase.id === id)?.transitions ?? {}),
      );
    }
  }
  for (const phase of source.phases)
    if (
      phase.capabilities?.some((capability) =>
        ["publication", "candidate-watch"].includes(capability),
      ) &&
      (!publication ||
        ![publication.approval, publication.commit, publication.push, publication.draft].includes(
          phase.id,
        ))
    )
      throw new PlaybookDefinitionSourceError(
        file,
        `phases.${phase.id}.capabilities`,
        "publication and candidate-watch require a prepared publication sequence and belong only on its approval, commit, push, or draft phases",
      );
  const agents = source.agents ?? {};
  const assignments: Record<string, { persona: string; authority: Authority }> = { ...agents };
  for (const phase of source.phases)
    for (const task of phase.tasks ?? [])
      if (task.persona)
        assignments[`inline:${phase.id}:${task.id}`] = {
          persona: task.persona,
          authority: task.authority ?? "read-only",
        };
  const phases: Phase[] = [
    {
      id: "__workspace",
      kind: "code",
      tasks: [{ id: "workspace", adapter: "workspace" }],
      transitions: { pass: source.initial },
      maxVisits: 1,
    },
    ...source.phases.map((phase) => ({
      id: phase.id,
      ...(phase.label ? { label: phase.label } : {}),
      kind: phase.kind,
      tasks: (phase.tasks ?? []).map((task) => {
        if (phase.kind !== "agent")
          if (phase.kind === "gate")
            throw new PlaybookDefinitionSourceError(
              file,
              `phases.${phase.id}.tasks`,
              "gates cannot have tasks",
            );
          else {
            if (!task.operation || task.agent || task.persona)
              throw new PlaybookDefinitionSourceError(
                file,
                `phases.${phase.id}.tasks.${task.id}`,
                "code tasks require one registered operation",
              );
            return { id: task.id, adapter: `custom_${task.operation}` };
          }
        if ((task.agent === undefined) === (task.persona === undefined))
          throw new PlaybookDefinitionSourceError(
            file,
            `phases.${phase.id}.tasks.${task.id}`,
            "set exactly one of agent or persona",
          );
        if (task.agent && !agents[task.agent])
          throw new PlaybookDefinitionSourceError(
            file,
            `phases.${phase.id}.tasks.${task.id}.agent`,
            `unknown agent ${task.agent}`,
          );
        if (!task.instructions || !task.output)
          throw new PlaybookDefinitionSourceError(
            file,
            `phases.${phase.id}.tasks.${task.id}`,
            "agent tasks require instructions and output",
          );
        return { id: task.id, adapter: "persona", ...(task.agent ? { agent: task.agent } : {}) };
      }),
      transitions: phase.transitions,
      maxVisits: phase.visitLimit ?? 1,
      capabilities: [
        ...new Set([
          ...(phase.capabilities ?? []),
          ...(publication &&
          [publication.approval, publication.commit, publication.push, publication.draft].includes(
            phase.id,
          )
            ? ["publication", "candidate-watch", ...(phase.kind === "gate" ? ["approval"] : [])]
            : []),
        ]),
      ],
    })),
  ];
  const taskSource = (phaseId: string, taskId: string) =>
    source.phases.find((phase) => phase.id === phaseId)?.tasks?.find((task) => task.id === taskId);
  const phaseArtifacts = (run: Run, phaseId: string): Artifact[] => {
    const tasks = source.phases.find((phase) => phase.id === phaseId)?.tasks ?? [];
    // A reviewer pair contributes both outputs, including corrected attempts on later visits.
    // Single-task phases also allow human-edited publication metadata to supersede the output.
    return (
      tasks.length > 1
        ? tasks.map((task) =>
            run.artifacts.findLast((item) => item.phase === phaseId && item.producer === task.id),
          )
        : [latest(run, phaseId)]
    ).filter((item): item is Artifact => item !== undefined);
  };
  const canonicalSource = stringify(source, { sortMapEntries: true, lineWidth: 0 });
  const implementation = `yaml-runtime/v1:${runtimeBuildHash}`;
  const definition: Omit<Definition, "hash"> = {
    ...(publication ? { publication } : {}),
    id: source.id,
    version: source.version,
    title: source.name,
    description: source.description,
    capabilities: [...new Set(phases.flatMap((phase) => phase.capabilities ?? []))],
    source: canonicalSource,
    runtime: implementation,
    agents: assignments,
    initial: "__workspace",
    phases,
    editGate: (run, content) => {
      if (!publication || run.phase !== publication.approval)
        throw new Error("Only publication metadata is editable");
      const fields = decodeMetadataFields(content);
      const artifact = latest(run, publication.metadata);
      if (!artifact) throw new Error("Publication preparation artifact is missing");
      return {
        artifact,
        content: {
          ...decodePublicationMetadata(artifact.content),
          ...fields,
        },
      };
    },
    input: (run, phase, task) => {
      if (phase.id === "__workspace")
        return { inputs: run.inputs, selectedEvidenceIds: [], selectedEvidenceHashes: [] };
      const authored = taskSource(phase.id, task.id)!;
      const authoredPhase = source.phases.find((item) => item.id === phase.id)!;
      const feedback = authored.operation === "feedback";
      const publishing =
        publication && phase.kind === "code" && phase.id !== publication.metadata && !feedback;
      const evidenceIds = [...(authoredPhase.evidence ?? [])];
      const approvalIds = [...(authoredPhase.approvals ?? [])];
      if (publication && phase.kind === "code") {
        evidenceIds.push("__workspace");
        if (feedback) evidenceIds.push(publication.draft);
        if (publishing) {
          evidenceIds.push(publication.metadata);
          approvalIds.push(publication.approval);
          if (phase.id === publication.push) evidenceIds.push(publication.commit);
          if (phase.id === publication.draft) evidenceIds.push(publication.push);
        }
      }
      const selected = [...new Set(evidenceIds)].flatMap((id) => phaseArtifacts(run, id));
      const decisions = run.approvals.filter((decision) =>
        approvalIds.includes(decision.phase ?? ""),
      );
      if (phase.kind === "code")
        return {
          inputs: run.inputs,
          selectedEvidenceIds: [
            ...selected.map((item) => item.id),
            ...decisions.map((item) => `decision:${hash(item)}`),
          ],
          selectedEvidenceHashes: [...selected.map((item) => item.hash), ...decisions.map(hash)],
        };
      const assignmentKey = authored.agent ?? `inline:${phase.id}:${task.id}`;
      const personaId = authored.agent ? agents[authored.agent]!.persona : authored.persona!;
      const execution = readPlaybookExecution(run.execution);
      const assignment = execution.personas[assignmentKey];
      if (!assignment) throw new Error(`Missing persona snapshot ${assignmentKey}`);
      return {
        personaId,
        authorityPolicy: assignment.authorityPolicy,
        assignmentKey,
        assignmentDigest: assignment.definitionDigest,
        ...(authored.agent ? { sharedInstance: authored.agent } : {}),
        prompt: `${authored.instructions!}\n${outputInstruction[authored.output!]}\n${canonical({ request: run.inputs, evidence: selected, gateFeedback: decisions })}`,
        worktree: String(
          (latest(run, "__workspace")?.content as { worktree?: unknown } | undefined)?.worktree ??
            run.repository,
        ),
        branch: String(
          (latest(run, "__workspace")?.content as { branch?: unknown } | undefined)?.branch ??
            run.baseCommit,
        ),
        selectedEvidenceIds: [
          ...selected.map((item) => item.id),
          ...decisions.map((item) => `decision:${hash(item)}`),
        ],
        selectedEvidenceHashes: [...selected.map((item) => item.hash), ...decisions.map(hash)],
      };
    },
    validate: (action: Action, output: unknown) => {
      if (action.kind !== "code" && canonical(output).length > 131072)
        throw new Error("Output exceeds 128 KiB");
      if (action.phase === "__workspace") return output;
      const authored = taskSource(action.phase, action.task)!;
      if (action.kind === "code") {
        return codeOutput[authored.operation as keyof typeof codeOutput](output);
      }
      const decoded = authored.output === "review" ? decodeReview(output) : decodeReport(output);
      if (authored.output === "review") {
        const item = decoded as typeof review.Type;
        if ((item.verdict === "revise") !== item.findings.some((finding) => finding.blocking))
          throw new Error("Review verdict must match blocking findings");
        if (!selectedEvidenceHashes(action.input).includes(item.subjectHash))
          throw new Error("Review refers to evidence outside this action");
      }
      return decoded;
    },
    outcome: (_run, phase, artifacts) => {
      const rule = source.phases.find((item) => item.id === phase.id)?.outcome ?? "completion";
      if (rule === "review")
        return artifacts.some((artifact) => decodeReview(artifact.content).verdict === "revise")
          ? "revise"
          : "completed";
      if (rule === "validation")
        return (artifacts[0]?.content as { passed?: unknown } | undefined)?.passed
          ? "pass"
          : "revise";
      return phase.kind === "code" ? "pass" : "completed";
    },
    gateArtifacts: (run, phase) => {
      const bindings = source.phases.find((item) => item.id === phase.id)?.evidence ?? [];
      return bindings.flatMap((id) => phaseArtifacts(run, id));
    },
  };
  const compiled = { ...definition, hash: hash([implementation, source]) };
  try {
    validateDefinition(compiled);
  } catch (cause) {
    throw new PlaybookDefinitionSourceError(
      file,
      "phases",
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  return compiled;
}
