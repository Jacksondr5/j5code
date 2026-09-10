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
  personas: Schema.Record(WorkflowRole, OrchestrationV2AgentPersonaAssignment),
});
export type WorkflowExecution = typeof WorkflowExecution.Type;
export const readWorkflowExecution = Schema.decodeUnknownSync(WorkflowExecution);
const decodeWorkflowExecution = Schema.decodeUnknownEffect(WorkflowExecution);
const isWorkflowExecution = Schema.is(WorkflowExecution);
export const legacyWorkflowMessage =
  "This workflow has no complete persona snapshots. Start a fresh task to continue.";
export const hasWorkflowSnapshots = (execution: unknown): boolean => {
  if (!isWorkflowExecution(execution)) return false;
  return Object.entries(workflowAuthorities).every(([role, authority]) => {
    const assignment = execution.personas[role as keyof typeof workflowAuthorities];
    return (
      assignment?.personaId === role &&
      assignment.authorityPolicy === authority &&
      assignment.definitionDigest !== undefined
    );
  });
};

/** One catalog read binds the entire run, including roles first used in later phases. */
export const prepareWorkflowExecution = Effect.fn("Workflow.prepareExecution")(function* (
  stateRoot: string,
  library: ReturnType<typeof createAgentPersonaLibrary>,
  providers: ReadonlyArray<ServerProvider>,
) {
  const catalog = yield* library.catalog();
  const capturedLibrary = { ...library, catalog: () => Effect.succeed(catalog) };
  const personas: {
    -readonly [K in keyof WorkflowExecution["personas"]]?: WorkflowExecution["personas"][K];
  } = {};
  for (const [personaId, authorityPolicy] of Object.entries(workflowAuthorities)) {
    const assignment = yield* prepareAgentPersonaLaunch(
      { personaId, authorityPolicy },
      providers,
      capturedLibrary,
    );
    if (!assignment.definitionDigest)
      return yield* new AgentPersonaLibraryError({
        message: "Workflow persona snapshot was not saved.",
      });
    personas[personaId as keyof typeof workflowAuthorities] = assignment;
  }
  return yield* decodeWorkflowExecution({ stateRoot, personas });
});
