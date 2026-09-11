import * as NodeCrypto from "node:crypto";
import type { Action, Artifact, Run } from "@j5/workflow-contracts";
import type { AgentPersonaAuthorityPolicy } from "@t3tools/contracts";

/** Object key order is not part of command or artifact identity. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Workflow values must be JSON serializable");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}
export const hash = (value: unknown): string =>
  NodeCrypto.createHash("sha256").update(canonical(value)).digest("hex");

export interface Task {
  readonly id: string;
  readonly adapter: string;
  /** Named workflow agent instance. Omitted for a fresh conversation. */
  readonly agent?: string;
}
export interface Phase {
  readonly id: string;
  readonly label?: string;
  readonly kind: "agent" | "code" | "gate";
  readonly tasks: ReadonlyArray<Task>;
  readonly transitions: Readonly<Record<string, string>>;
  readonly maxVisits: number;
  readonly capabilities?: ReadonlyArray<string>;
}
export interface Definition {
  readonly id: string;
  readonly version: number;
  /** Includes executable implementation version, schemas, prompts, and phase table. */
  readonly hash: string;
  readonly initial: string;
  readonly phases: ReadonlyArray<Phase>;
  readonly title?: string;
  readonly description?: string;
  readonly capabilities?: ReadonlyArray<string>;
  /** Canonical authoring source persisted with new runs. */
  readonly source?: string;
  /** Runtime implementation pinned into YAML workflow identity and execution snapshots. */
  readonly runtime?: string;
  readonly agents?: Readonly<
    Record<string, { readonly persona: string; readonly authority: AgentPersonaAuthorityPolicy }>
  >;
  readonly input: (run: Run, phase: Phase, task: Task) => unknown;
  readonly validate: (action: Action, output: unknown, run: Run) => unknown;
  readonly outcome: (run: Run, phase: Phase, artifacts: ReadonlyArray<Artifact>) => string;
  readonly gateArtifacts: (run: Run, phase: Phase) => ReadonlyArray<Artifact>;
  readonly editGate?: (
    run: Run,
    content: unknown,
  ) => { readonly artifact: Artifact; readonly content: unknown };
}

export function phaseById(definition: Definition, id: string): Phase {
  const phase = definition.phases.find((item) => item.id === id);
  if (!phase) throw new Error(`Unknown phase ${id}`);
  return phase;
}

export function validateDefinition(definition: Definition): void {
  const ids = new Set(definition.phases.map((phase) => phase.id));
  if (ids.size !== definition.phases.length || !ids.has(definition.initial)) {
    throw new Error("Definition phase ids must be unique and include initial phase");
  }
  for (const phase of definition.phases) {
    if (phase.maxVisits < 1 || (phase.kind !== "gate" && phase.tasks.length === 0)) {
      throw new Error(`Invalid phase ${phase.id}`);
    }
    if (new Set(phase.tasks.map((task) => task.id)).size !== phase.tasks.length) {
      throw new Error(`Duplicate task in ${phase.id}`);
    }
    const shared = phase.tasks.flatMap((task) => (task.agent ? [task.agent] : []));
    if (new Set(shared).size !== shared.length)
      throw new Error(`Shared agent is scheduled twice in phase ${phase.id}`);
    for (const next of Object.values(phase.transitions)) {
      if (next !== "$complete" && !ids.has(next)) throw new Error(`Unknown transition ${next}`);
    }
  }
  const reachable = new Set<string>();
  const pending = [definition.initial];
  while (pending.length) {
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const phase = definition.phases.find((item) => item.id === id)!;
    pending.push(...Object.values(phase.transitions).filter((next) => next !== "$complete"));
  }
  const unreachable = definition.phases.find((phase) => !reachable.has(phase.id));
  if (unreachable) throw new Error(`Unreachable phase ${unreachable.id}`);
}

export const gateHash = (artifacts: readonly Artifact[]): string =>
  hash(artifacts.map(({ id, hash: contentHash }) => ({ id, contentHash })));
