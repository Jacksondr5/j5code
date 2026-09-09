import * as Effect from "effect/Effect";
import type { OrchestrationV2AppThread } from "@t3tools/contracts";
import { ProviderAdapterV2RuntimePolicy } from "../../orchestration-v2/ProviderAdapter.ts";
import { getBuiltInAgentPersonaInstructions } from "./agentPersonaPrompts.ts";
import {
  AgentPersonaLibraryError,
  makeAgentPersonaLibrary,
  type createAgentPersonaLibrary,
} from "./agentPersonaLibrary.ts";
import { getAgentAuthorityRules } from "./agentPersonas.ts";
import {
  providerCanEnforceAgentPersonaAuthority,
  translateAgentPersonaProviderPolicy,
} from "./agentPersonaProviderPolicy.ts";

/** Persona instructions express behavior; the translated sandbox supplies the actual runtime boundary. */
export const resolveAgentPersonaRuntime = Effect.fn("resolveAgentPersonaRuntime")(function* (
  thread: Pick<OrchestrationV2AppThread, "agentPersonaAssignment" | "runtimeMode">,
  library: ReturnType<typeof createAgentPersonaLibrary>,
) {
  const assignment = thread.agentPersonaAssignment;
  if (assignment === undefined) return { runtimeMode: thread.runtimeMode };
  let instructions: string | undefined;
  if (assignment.definitionDigest === undefined) {
    instructions = getBuiltInAgentPersonaInstructions(assignment);
  } else {
    const definition = yield* library.readSnapshot(assignment);
    if (
      !definition.authority.allowedPolicies.includes(assignment.authorityPolicy) ||
      !providerCanEnforceAgentPersonaAuthority(
        assignment.resolvedDriver,
        assignment.authorityPolicy,
      )
    ) {
      return yield* new AgentPersonaLibraryError({
        message: "The assigned persona runtime permissions are unsupported.",
      });
    }
    const rules = getAgentAuthorityRules(assignment.authorityPolicy);
    instructions = `${definition.instructions}\n\n## Selected behavior: ${assignment.authorityPolicy}\nThese are operating instructions, not additional sandbox guarantees.\n${
      rules.mayCommit
        ? "Commit and push only within the authorized publication scope."
        : "Never commit or push."
    }\n${rules.mayWritePullRequest ? "Open or update pull requests only within the authorized scope." : "Do not mutate pull requests."}\nNever merge a pull request.\n${
      assignment.authorityPolicy === "critic-fix"
        ? "Edit only to address the requested review findings."
        : ""
    }`;
  }
  return {
    ...translateAgentPersonaProviderPolicy(assignment.authorityPolicy, assignment.resolvedDriver),
    ...(instructions === undefined ? {} : { agentPersonaInstructions: instructions }),
  };
});

/** The thread's full runtime policy: persona sandbox and instructions when assigned, the plain mode otherwise. */
export const resolveAgentPersonaRuntimePolicy = (
  input: { readonly thread: OrchestrationV2AppThread; readonly cwd: string | null },
  library: ReturnType<typeof createAgentPersonaLibrary>,
) =>
  resolveAgentPersonaRuntime(input.thread, library).pipe(
    Effect.map((policy) =>
      ProviderAdapterV2RuntimePolicy.make({
        ...policy,
        interactionMode: input.thread.interactionMode,
        cwd: input.cwd,
      }),
    ),
  );

export interface AgentPersonaRuntimePolicyInput {
  readonly thread: OrchestrationV2AppThread;
  readonly cwd: string | null;
}

/**
 * Resolver for the upstream RuntimePolicy layers: builds the library once and maps failures
 * through the caller-supplied error constructor, so the upstream file adds no persona logic.
 */
export const makeAgentPersonaRuntimePolicyResolver = <E>(
  toError: (input: AgentPersonaRuntimePolicyInput, cause: unknown) => E,
) =>
  Effect.gen(function* () {
    const library = yield* makeAgentPersonaLibrary;
    return (input: AgentPersonaRuntimePolicyInput) =>
      resolveAgentPersonaRuntimePolicy(input, library).pipe(
        Effect.mapError((cause) => toError(input, cause)),
      );
  });
