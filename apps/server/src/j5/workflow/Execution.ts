import { OrchestrationV2AgentPersonaAssignment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ServerProvider } from "@t3tools/contracts";
import {
  AgentPersonaLibraryError,
  type createAgentPersonaLibrary,
} from "../agents/agentPersonaLibrary.ts";
import { prepareAgentPersonaLaunch } from "../agents/agentPersonaLaunch.ts";

export const workflowAuthorities = {
  scout: "read-only",
  navigator: "read-only",
  advocate: "read-only",
  skeptic: "read-only",
  builder: "workspace-write",
  critic: "critic-review",
  sentry: "read-only",
} as const;
export const WorkflowRole = Schema.Literals(
  Object.keys(workflowAuthorities) as [
    keyof typeof workflowAuthorities,
    ...Array<keyof typeof workflowAuthorities>,
  ],
);
export const WorkflowExecution = Schema.Struct({
  stateRoot: Schema.String,
  personas: Schema.Record(Schema.String, OrchestrationV2AgentPersonaAssignment),
  definition: Schema.optional(
    Schema.Struct({
      source: Schema.String,
      runtime: Schema.String,
    }),
  ),
});
type PersonaAssignment = typeof OrchestrationV2AgentPersonaAssignment.Type;
export type WorkflowExecution = Omit<typeof WorkflowExecution.Type, "personas"> & {
  readonly personas: Readonly<Record<string, PersonaAssignment>> &
    Readonly<Record<keyof typeof workflowAuthorities, PersonaAssignment>>;
};
const decodeExecution = Schema.decodeUnknownSync(WorkflowExecution);
export const readWorkflowExecution = (value: unknown) =>
  decodeExecution(value) as WorkflowExecution;
const isWorkflowExecution = Schema.is(WorkflowExecution);
export const legacyWorkflowMessage =
  "This workflow has no complete persona snapshots. Start a fresh task to continue.";
export const hasWorkflowSnapshots = (execution: unknown): boolean => {
  if (!isWorkflowExecution(execution)) return false;
  const assignments = Object.values(execution.personas);
  if (!assignments.length || assignments.some((assignment) => !assignment.definitionDigest))
    return false;
  if (execution.definition) return true;
  return Object.entries(workflowAuthorities).every(
    ([role, authority]) =>
      execution.personas[role]?.personaId === role &&
      execution.personas[role]?.authorityPolicy === authority,
  );
};

/** One catalog read binds the entire run, including roles first used in later phases. */
export const prepareWorkflowExecution = Effect.fn("Workflow.prepareExecution")(function* (
  stateRoot: string,
  library: ReturnType<typeof createAgentPersonaLibrary>,
  providers: ReadonlyArray<ServerProvider>,
  requested: Readonly<
    Record<
      string,
      { readonly persona: string; readonly authority: PersonaAssignment["authorityPolicy"] }
    >
  > = Object.fromEntries(
    Object.entries(workflowAuthorities).map(([persona, authority]) => [
      persona,
      { persona, authority },
    ]),
  ),
  definition?: { readonly source: string; readonly runtime: string },
) {
  const catalog = yield* library.catalog();
  const capturedLibrary = { ...library, catalog: () => Effect.succeed(catalog) };
  const personas: {
    -readonly [K in keyof WorkflowExecution["personas"]]?: WorkflowExecution["personas"][K];
  } = {};
  for (const [assignmentKey, requestedAssignment] of Object.entries(requested)) {
    const { persona: personaId, authority: authorityPolicy } = requestedAssignment;
    const assignment = yield* prepareAgentPersonaLaunch(
      { personaId, authorityPolicy },
      providers,
      capturedLibrary,
    );
    if (!assignment.definitionDigest)
      return yield* new AgentPersonaLibraryError({
        message: "Workflow persona snapshot was not saved.",
      });
    personas[assignmentKey] = assignment;
  }
  return readWorkflowExecution({ stateRoot, personas, ...(definition ? { definition } : {}) });
});
