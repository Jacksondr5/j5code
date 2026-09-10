import * as NodeCrypto from "node:crypto";
import type { Action, Artifact, Run } from "@j5/workflow-contracts";

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
}
export interface Phase {
  readonly id: string;
  readonly kind: "agent" | "code" | "gate";
  readonly tasks: ReadonlyArray<Task>;
  readonly transitions: Readonly<Record<string, string>>;
  readonly maxVisits: number;
}
export interface Definition {
  readonly id: string;
  readonly version: number;
  /** Includes executable implementation version, schemas, prompts, and phase table. */
  readonly hash: string;
  readonly initial: string;
  readonly phases: ReadonlyArray<Phase>;
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
    for (const next of Object.values(phase.transitions)) {
      if (next !== "$complete" && !ids.has(next)) throw new Error(`Unknown transition ${next}`);
    }
  }
}

export const gateHash = (artifacts: readonly Artifact[]): string =>
  hash(artifacts.map(({ id, hash: contentHash }) => ({ id, contentHash })));
